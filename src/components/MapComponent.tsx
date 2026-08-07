import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.vectorgrid';
import {
  AlertTriangle, ChevronDown, Crosshair, Eye, Layers, Loader2, MousePointerClick, Shield
} from 'lucide-react';

import type {
  Campsite, DestinationLand, MapDestination, MapTileLayer
} from '../types';
import { getCachedTile } from '../services/offlineStorage';
import { pointInGeometry } from '../utils/geo';
import { hazardReportStyle, reportStanding } from '../config/hazardReports';
import { RIG_AVATAR, UNKNOWN_RIG_EMOJI } from '../config/rigs';
import { fetchHazardsNear, HazardRecord, NearbyCamper } from '../services/dataService';
import type { RouteResult } from '../services/routingService';
import {
  fetchBoundaries, requestBoxFor, overviewBoxFor, boxContains, BOUNDARY_STYLES,
  EMPTY_BOUNDARIES, BoundaryCollection, BoundaryConfidence, BoundaryFeature,
  BoundaryDetail, EdgeAccuracy
} from '../services/boundaryService';
import {
  buildFuzzRings, ringBudget, edgeBlurPx, UNCERTAINTY_LABEL, shouldSimplify
} from '../utils/fuzzyBoundary';
import {
  BoundingBox, COVERAGE_OUTLINE, WORLD_RING, BOUNDARY_MIN_ZOOM,
  BOUNDARY_OVERVIEW_MIN_ZOOM, overviewMinAreaSqKm,
  COVERAGE_LABEL, isWithinCoverage
} from '../config/coverage';
import {
  fetchAreaAlerts, HazardAlert, HAZARD_STYLE, sortAlerts
} from '../services/weatherService';

/** 1x1 transparent GIF, shown where no offline tile has been cached. */
const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const TILE_URLS: Record<MapTileLayer, { url: string; attribution: string; label: string }> = {
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    label: 'Satellite'
  },
  topo: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors, SRTM | Style: &copy; OpenTopoMap (CC-BY-SA)',
    label: 'Topographic'
  },
  street: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    label: 'Street'
  }
};

/**
 * Leaflet's GeoJSON layer forwards its options straight to the Path objects it
 * builds, so `renderer` reaches them — but @types/leaflet doesn't declare it on
 * GeoJSONOptions. This is that gap, not a behaviour change.
 */
type RenderedGeoJSONOptions = L.GeoJSONOptions & { renderer: L.Renderer };

/**
 * Shared tile options that keep the network quiet while the map is moving.
 *
 * By default Leaflet requests a fresh grid of tiles at every intermediate zoom
 * level of a pinch or scroll, so a two-level zoom fires three rounds of
 * requests and throws two of them away. Waiting for the gesture to finish means
 * one round instead, which is most of why zooming felt like wading through mud.
 */
const TILE_PERFORMANCE = {
  updateWhenZooming: false,
  /**
   * Load tiles DURING a pan, not only once it stops.
   *
   * Leaflet defaults this to true on mobile, which means a drag shows bare
   * background wherever you haven't been yet and only starts fetching when
   * your finger lifts. That is the empty blue you see at the edges while
   * scrolling. It costs more requests mid-gesture; the low-resolution
   * underlay below covers the gap until they land.
   */
  updateWhenIdle: false,
  /** Extra rings of tiles held off-screen so a short pan has nothing to fetch. */
  keepBuffer: 4
} as const;

/**
 * Zoom level the always-there backdrop is drawn from.
 *
 * Low enough that a handful of tiles cover a whole region and they stay in the
 * browser cache; high enough that the upscaled result reads as terrain rather
 * than coloured mush.
 */
const UNDERLAY_NATIVE_ZOOM = 8;

/**
 * The hard edge of the map.
 *
 * Web Mercator can't represent latitude beyond about ±85.05°, and without an
 * explicit bound Leaflet tiles the world infinitely sideways. That's what
 * produced three side-by-side copies of Earth: the tile layer repeated, but
 * the grey coverage mask is a single polygon, so it only landed on the middle
 * copy while the others sat there unmasked.
 */
const WORLD_BOUNDS = L.latLngBounds([-85.05, -180], [85.05, 180]);

/**
 * Smallest zoom at which the world still fills the viewport width.
 *
 * Hard-coding a number breaks somewhere: too high and phones can't zoom out
 * far enough, too low and an ultrawide monitor shows empty gutters either side
 * of the map. The world is 256px across at zoom 0 and doubles each level, so
 * solve for it from the actual container width instead of guessing.
 */
const worldFillZoom = (widthPx: number): number =>
  Math.max(1, Math.ceil(Math.log2(Math.max(widthPx, 1) / 256)));

/**
 * WHAT GETS AN ICON ON THIS MAP, AND WHAT DOESN'T
 *
 * Only two things: something a camper reported, and somewhere a camper added.
 * Nothing else earns a pin.
 *
 * Every campsite used to get one, colour-coded by land type, which meant a
 * region with a lot of BLM sections drew as a solid mat of orange dots over
 * the terrain a camper was trying to read. Worse, those pins were mostly
 * derived — an OpenStreetMap node or a curated row saying "there is BLM land
 * here" — and a pin is a much stronger claim than that. It says "this is a
 * place". The land itself is already drawn, as the boundary polygon it
 * actually is, with a fuzzy edge saying how sure we are.
 *
 * So: no land-type pins. Camper-submitted spots keep theirs, because somebody
 * stood there. Camper hazard reports get theirs, because somebody drove it.
 * Official alerts keep their warning triangles. That's the whole set.
 */

/** A spot a camper added themselves. */
const buildCampsiteIcon = (isSelected: boolean): L.DivIcon =>
  L.divIcon({
    className: 'custom-campsite-marker',
    html: `
      <div class="relative flex items-center justify-center ${isSelected ? 'scale-125 z-50' : 'z-10'}">
        <div class="w-8 h-8 rounded-full flex items-center justify-center shadow-xl border-2 bg-emerald-500 ${
          isSelected ? 'border-white ring-4 ring-emerald-400/50' : 'border-slate-900'
        }">
          <svg class="w-4 h-4 text-slate-950 stroke-[2.5]" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M19 20 12 4 5 20" /><path d="M12 4v16" /><path d="M2 20h20" />
          </svg>
        </div>
      </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });

/**
 * A camper's hazard report.
 *
 * A rounded chip, never a triangle — the triangle belongs to the National
 * Weather Service and Environment Canada, and one person's report must not
 * borrow the look of an agency's warning. See src/config/hazardReports.ts.
 */
const buildHazardReportIcon = (record: HazardRecord): L.DivIcon => {
  const style = hazardReportStyle(record.kind);
  const confirmed = reportStanding(record.confirms, record.disputes) === 'confirmed';
  const size = style.prominent ? 30 : 24;

  return L.divIcon({
    className: 'hazard-report-marker',
    html: `
      <div class="relative flex items-center justify-center">
        <div class="rounded-lg flex items-center justify-center shadow-lg border-2"
             style="width:${size}px;height:${size}px;background:${style.color};border-color:${
      confirmed ? '#F8FAFC' : '#0F172A'
    }">
          <span style="font-size:${size * 0.5}px;line-height:1">${style.emoji}</span>
        </div>
      </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
};

/**
 * The pin the user drops by tapping.
 *
 * A teardrop rather than a circle, so at a glance it never reads as one of the
 * data pins around it. This is the one marker on the map that came from the
 * user rather than from a source.
 */
const buildDestinationIcon = (): L.DivIcon =>
  L.divIcon({
    className: 'destination-marker',
    html: `
      <div class="relative flex items-end justify-center anim-pin-drop">
        <span class="absolute bottom-0 w-6 h-2 rounded-full bg-slate-950/40 blur-[2px]"></span>
        <svg viewBox="0 0 24 32" class="w-8 h-10 drop-shadow-xl relative" aria-hidden="true">
          <path d="M12 1c5.2 0 9.4 4.2 9.4 9.4 0 6.8-9.4 20.6-9.4 20.6S2.6 17.2 2.6 10.4C2.6 5.2 6.8 1 12 1z"
                fill="#F43F5E" stroke="#0F172A" stroke-width="1.7" stroke-linejoin="round"/>
          <circle cx="12" cy="10.4" r="3.5" fill="#0F172A"/>
        </svg>
      </div>`,
    iconSize: [32, 40],
    iconAnchor: [16, 40]
  });

/**
 * A camper on the road — you, or somebody else.
 *
 * Yours is the plain camper van; a placeholder until there's a rig picker
 * wired to it. Friends get their own rig's avatar and their name. Everyone
 * else gets a muted dot and no name at all.
 *
 * ON THE WORD "ANONYMOUS": positions here are already snapped to a ~1 km grid
 * by the server before they leave the database, and the app withholds the
 * handle for anyone who isn't a friend. But the handle IS in the response —
 * hiding it is a display choice, not a guarantee, and the UI says "names
 * hidden" rather than "anonymous" for exactly that reason.
 */
const buildCamperIcon = (options: {
  emoji: string;
  name?: string;
  isSelf?: boolean;
}): L.DivIcon => {
  const { emoji, name, isSelf } = options;
  const ring = isSelf ? '#34D399' : name ? '#38BDF8' : '#64748B';

  const label = name
    ? `<span class="mt-0.5 px-1.5 py-px rounded-md bg-slate-950/85 text-[9px] font-bold text-slate-100 whitespace-nowrap shadow">${name}</span>`
    : '';

  return L.divIcon({
    className: 'camper-avatar-marker',
    html: `
      <div class="relative flex flex-col items-center">
        ${isSelf ? '<span class="absolute -top-1 w-11 h-11 rounded-full bg-emerald-400/25 anim-pulse"></span>' : ''}
        <div class="relative w-9 h-9 rounded-full flex items-center justify-center shadow-xl border-2 bg-slate-900"
             style="border-color:${ring}">
          <span style="font-size:17px;line-height:1">${emoji}</span>
        </div>
        ${label}
      </div>`,
    iconSize: [36, name ? 52 : 36],
    iconAnchor: [18, 18]
  });
};

/** Your vehicle avatar. A plain camper for now, as asked. */
const SELF_CAMPER_SVG = `
  <svg viewBox="0 0 40 28" class="w-7 h-5" aria-hidden="true">
    <rect x="1.5" y="5" width="26" height="14" rx="3" fill="#F8FAFC" stroke="#0F172A" stroke-width="1.4"/>
    <path d="M27.5 9h5.2l4.8 5.4V19h-10z" fill="#E2E8F0" stroke="#0F172A" stroke-width="1.4" stroke-linejoin="round"/>
    <rect x="5.5" y="8" width="7.5" height="5" rx="1.2" fill="#38BDF8"/>
    <rect x="1.5" y="14.5" width="26" height="2.6" fill="#10B981"/>
    <circle cx="9.5" cy="20.5" r="3.6" fill="#0F172A"/>
    <circle cx="30" cy="20.5" r="3.6" fill="#0F172A"/>
    <circle cx="9.5" cy="20.5" r="1.3" fill="#94A3B8"/>
    <circle cx="30" cy="20.5" r="1.3" fill="#94A3B8"/>
  </svg>`;

/**
 * Rough size of a shape, as the area of its bounding box in square degrees.
 *
 * Only ever used to rank two overlapping parcels against each other, so the
 * distortion of treating degrees as a flat grid does not matter — both shapes
 * sit at the same latitude, because they both contain the same tapped point.
 */
const bboxExtent = (geometry: unknown): number => {
  const g = geometry as { coordinates?: unknown };
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;

  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [lon, lat] = node as [number, number];
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    node.forEach(walk);
  };

  walk(g?.coordinates);
  if (minLon === Infinity) return Number.MAX_SAFE_INTEGER;
  return (maxLon - minLon) * (maxLat - minLat);
};

/** Pull the fields we show from a boundary feature's properties. */
const landFromFeature = (properties: Record<string, any> | undefined): DestinationLand | undefined => {
  const p = properties;
  if (!p) return undefined;
  return {
    name: p._name ?? 'Public land',
    designation: p._designation ?? p._confidence ?? 'Public land',
    attribution: p._attribution ?? undefined,
    stayLimitDays: p._stayLimitDays ?? undefined,
    permitRequired: p._permitRequired ?? undefined,
    permitName: p._permitName ?? undefined,
    permitUrl: p._permitUrl ?? undefined,
    fireBanActive: p._fireBanActive ?? undefined,
    campfirePolicy: p._campfirePolicy ?? undefined
  };
};


/**
 * The warning triangle drawn over an active alert area.
 *
 * Sized generously and given a dark outline so it stays readable over both
 * bright snow and dark forest in satellite imagery.
 */
const buildHazardIcon = (alert: HazardAlert): L.DivIcon => {
  const style = HAZARD_STYLE[alert.family] ?? HAZARD_STYLE.other;
  const urgent = alert.severity === 'extreme' || alert.severity === 'severe';

  return L.divIcon({
    className: 'hazard-alert-marker',
    html: `
      <div class="relative flex items-center justify-center${urgent ? ' anim-pulse-danger' : ''}">
        <svg viewBox="0 0 24 24" class="w-8 h-8 drop-shadow-lg" aria-hidden="true">
          <path d="M12 2.5 22.5 21H1.5Z" fill="${style.color}" stroke="#0F172A" stroke-width="1.6"
                stroke-linejoin="round"/>
          <path d="M12 9.2v5.1" stroke="#0F172A" stroke-width="2.1" stroke-linecap="round"/>
          <circle cx="12" cy="17.6" r="1.15" fill="#0F172A"/>
        </svg>
      </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 24]
  });
};

interface MapComponentProps {
  campsites: Campsite[];
  selectedCampsite: Campsite | null;
  onSelectCampsite: (site: Campsite) => void;
  center: [number, number];
  zoom: number;
  userLocation: [number, number] | null;
  isOfflineMode: boolean;
  onOpenDetailModal: (site: Campsite) => void;
  onLocateUser?: () => void;
  isLocating?: boolean;

  /** The pin the user dropped, or the site they selected. Null when neither. */
  destination: MapDestination | null;
  /** Fired when the user taps bare map. Carries the land under the tap. */
  onDropDestination: (lat: number, lon: number, land?: DestinationLand) => void;
  /** Fired when a camper's hazard report is tapped. */
  onSelectHazardReport?: (record: HazardRecord) => void;

  /** The route being followed, or null when not navigating. */
  route: RouteResult | null;
  isNavigating: boolean;
  /** Other campers to draw while navigating. */
  nearbyCampers?: NearbyCamper[];
  /** Whose names may be shown. Everyone else stays unnamed. */
  friendIds?: Set<string>;
}

export const MapComponent: React.FC<MapComponentProps> = ({
  campsites, selectedCampsite, onSelectCampsite, center, zoom, userLocation,
  isOfflineMode, onOpenDetailModal, onLocateUser,
  isLocating = false,
  destination, onDropDestination, onSelectHazardReport,
  route, isNavigating, nearbyCampers = [], friendIds
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const userMarkerRef = useRef<L.Marker | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const underlayLayerRef = useRef<L.TileLayer | null>(null);
  const boundaryLayerRef = useRef<L.LayerGroup | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  // What boundary data we already hold, so a pan inside it costs nothing.
  const loadedBoxRef = useRef<BoundingBox | null>(null);
  const loadedZoomRef = useRef<number>(0);
  const collectionRef = useRef<BoundaryCollection>(EMPTY_BOUNDARIES);
  const boundaryRendererRef = useRef<L.Canvas | null>(null);
  /** Which tier is on screen, and at what settings — see `render`. */
  const loadedDetailRef = useRef<BoundaryDetail | null>(null);
  const overviewTierRef = useRef<number>(0);
  const renderSignatureRef = useRef<string>('');
  const renderedCollectionRef = useRef<BoundaryCollection | null>(null);
  const fillLayerRef = useRef<L.GeoJSON | null>(null);
  const haloLayerRef = useRef<L.LayerGroup | null>(null);
  const hazardLayerRef = useRef<L.LayerGroup | null>(null);
  const reportLayerRef = useRef<L.LayerGroup | null>(null);
  const destinationMarkerRef = useRef<L.Marker | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const camperLayerRef = useRef<L.LayerGroup | null>(null);

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
  const reportTapRef = useRef(onSelectHazardReport);
  reportTapRef.current = onSelectHazardReport;
  const navigatingRef = useRef(isNavigating);
  navigatingRef.current = isNavigating;

  const [activeTileLayer, setActiveTileLayer] = useState<MapTileLayer>('satellite');
  const [isMapReady, setIsMapReady] = useState(false);
  const [showCrownLand, setShowCrownLand] = useState(true);
  const [crownLandAvailable, setCrownLandAvailable] = useState(false);
  const [showLayerMenu, setShowLayerMenu] = useState(false);
  // Collapsed by default: the map matters more than the key to it.
  const [showLegend, setShowLegend] = useState(false);
  const [showBoundaries, setShowBoundaries] = useState(true);
  const [boundaries, setBoundaries] = useState<BoundaryCollection>(EMPTY_BOUNDARIES);
  const [isLoadingBoundaries, setIsLoadingBoundaries] = useState(false);
  const [zoomTooFar, setZoomTooFar] = useState(false);
  /** True while the map is showing the large-parcels-only overview. */
  const [isOverviewTier, setIsOverviewTier] = useState(false);
  const [hazards, setHazards] = useState<HazardAlert[]>([]);
  const [unmappableHazards, setUnmappableHazards] = useState(0);
  /** Camper-filed reports currently on screen — counted in the status chip. */
  const [hazardReports, setHazardReports] = useState<HazardRecord[]>([]);

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
      // One Earth, not three. `maxBounds` with full viscosity stops the user
      // dragging past the edge of the world into empty space.
      worldCopyJump: false,
      maxBounds: WORLD_BOUNDS,
      maxBoundsViscosity: 1.0
    });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);

    /**
     * Keep the minimum zoom tied to the container width.
     *
     * Recomputed on resize so rotating a phone or dragging a window narrower
     * can't strand the user at a zoom level that's now below the minimum.
     */
    const applyMinZoom = () => {
      const next = worldFillZoom(map.getSize().x);
      map.setMinZoom(next);
      if (map.getZoom() < next) map.setZoom(next);
    };
    applyMinZoom();
    map.on('resize', applyMinZoom);

    mapRef.current = map;
    setIsMapReady(true);

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
      // noWrap + bounds: draw the world exactly once. Without these the layer
      // repeats horizontally and the coverage mask only covers one copy.
      layer = new OfflineTileLayer('', {
        ...TILE_PERFORMANCE,
        maxZoom: 19,
        noWrap: true,
        bounds: WORLD_BOUNDS,
        attribution: 'Offline tile cache'
      });
    } else {
      const config = TILE_URLS[activeTileLayer];
      layer = L.tileLayer(config.url, {
        ...TILE_PERFORMANCE,
        maxZoom: 19,
        noWrap: true,
        bounds: WORLD_BOUNDS,
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
        bounds: WORLD_BOUNDS,
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
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    if (!map.getPane('coveragePane')) {
      map.createPane('coveragePane');
      const pane = map.getPane('coveragePane');
      if (pane) { pane.style.zIndex = '450'; pane.style.pointerEvents = 'none'; }
    }

    const toLatLng = (ring: [number, number][]) =>
      ring.map(([lon, lat]) => [lat, lon] as [number, number]);

    /**
     * Draw the mask once and then just move it.
     *
     * This shape never changes — it is the same thirty-odd coordinates for the
     * life of the app — but as an SVG path Leaflet re-projected and re-emitted
     * it on the end of every pan and zoom, and a world-sized path is a lot of
     * geometry to hand the browser for a shape that hasn't moved. On a canvas
     * with a generous padding it is rasterised once into a surface three times
     * the size of the screen, and an ordinary pan or two just slides that
     * surface around without redrawing anything at all.
     *
     * The padding is what buys that. It costs one oversized canvas of memory
     * and removes the grey edge flickering as you scroll.
     */
    const renderer = L.canvas({ pane: 'coveragePane', padding: 1 });

    // A world-sized polygon with the supported region punched out of it. Now
    // that the tile layer no longer repeats, this covers everything outside
    // coverage exactly once.
    const mask = L.polygon([toLatLng(WORLD_RING), toLatLng(COVERAGE_OUTLINE)], {
      pane: 'coveragePane', renderer, interactive: false, stroke: true,
      color: '#64748B', weight: 1, fillColor: '#0F172A', fillOpacity: 0.72
    } as L.PolylineOptions).addTo(map);

    return () => {
      try { map.removeLayer(mask); } catch { /* detached */ }
      try { map.removeLayer(renderer); } catch { /* never attached */ }
    };
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
    };

    const forget = () => {
      loadedBoxRef.current = null;
      loadedDetailRef.current = null;
      overviewTierRef.current = 0;
      collectionRef.current = EMPTY_BOUNDARIES;
    };

    if (!showBoundaries || isOfflineMode) {
      clearLayer();
      forget();
      setBoundaries(EMPTY_BOUNDARIES);
      setZoomTooFar(false);
      setIsOverviewTier(false);
      return;
    }

    let cancelled = false;
    let controller: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let requestId = 0;

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
    const parcelStyle = (feature: any, centreLat: number, currentZoom: number, overview: boolean) => {
      const confidence: BoundaryConfidence =
        feature?.properties?._confidence ?? 'managing_agency';
      const style = BOUNDARY_STYLES[confidence] ?? BOUNDARY_STYLES.managing_agency;

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

      const accuracy: EdgeAccuracy = feature?.properties?._edgeAccuracy ?? 'administrative';
      return {
        color: style.color,
        fillColor: style.fillColor,
        fillOpacity: style.fillOpacity,
        // Where the uncertainty band is too thin to draw, the outline stands
        // in for it, so the parcel still has a visible edge.
        weight: shouldSimplify(accuracy, centreLat, currentZoom) ? 1.2 : 0,
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
      currentZoom: number
    ): { group: L.LayerGroup; widest: number } => {
      const rings = ringBudget(collection.features.length);
      const renderer = boundaryRenderer();

      const bands = new Map<string, { accuracy: EdgeAccuracy; color: string; features: BoundaryFeature[] }>();
      collection.features.forEach((feature) => {
        const accuracy: EdgeAccuracy = feature?.properties?._edgeAccuracy ?? 'administrative';
        // Below a few pixels the band is thinner than the line itself; the
        // fill layer draws a hairline for those instead.
        if (shouldSimplify(accuracy, centreLat, currentZoom)) return;

        const confidence: BoundaryConfidence = feature?.properties?._confidence ?? 'managing_agency';
        const style = BOUNDARY_STYLES[confidence] ?? BOUNDARY_STYLES.managing_agency;
        const key = `${accuracy}|${confidence}`;

        const existing = bands.get(key);
        if (existing) existing.features.push(feature);
        else bands.set(key, { accuracy, color: style.color, features: [feature] });
      });

      const group = L.layerGroup([], { pane: 'boundariesPane' });
      let widest = 0;

      bands.forEach(({ accuracy, color, features }) => {
        const ringSpecs = buildFuzzRings(accuracy, centreLat, currentZoom, rings);
        widest = Math.max(widest, ringSpecs[0]?.weight ?? 0);

        ringSpecs.forEach((ring) => {
          group.addLayer(
            L.geoJSON({ type: 'FeatureCollection', features } as any, {
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
      const pane = boundaryPane();
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
      const signature = `${detail}|${zoomKey}|${collection.features.length}|${
        collection.features[0]?.properties?._name ?? ''
      }`;

      // Compared against what is ON THE MAP, not against what was last
      // fetched — those are the same object right after a fetch, and confusing
      // them would let new data slip through the cheap zoom-only path below
      // and never actually reach the screen.
      const sameData = renderedCollectionRef.current === collection;
      if (sameData && signature === renderSignatureRef.current && boundaryLayerRef.current) return;

      /* -- Zoom-only change: rebuild the halo, keep the parcels ---------- */
      if (sameData && fillLayerRef.current && boundaryLayerRef.current && !overview) {
        const group = boundaryLayerRef.current;
        if (haloLayerRef.current) {
          try { group.removeLayer(haloLayerRef.current); } catch { /* gone */ }
        }
        const { group: halo, widest } = buildHalo(collection, centreLat, currentZoom);
        haloLayerRef.current = halo;
        group.addLayer(halo);
        fillLayerRef.current.setStyle((f: any) => parcelStyle(f, centreLat, currentZoom, false));
        if (pane) pane.style.filter = widest > 0 ? `blur(${edgeBlurPx(widest).toFixed(1)}px)` : '';
        renderSignatureRef.current = signature;
        renderedCollectionRef.current = collection;
        return;
      }

      /* -- New data: full rebuild --------------------------------------- */
      clearLayer();
      const renderer = boundaryRenderer();

      // No uncertainty band in the overview. At zoom 4 a ±200 m band is a
      // fraction of a pixel, so it would draw as a slightly thicker line that
      // says nothing — while costing one extra pass over every polygon.
      const halo = overview ? null : buildHalo(collection, centreLat, currentZoom);
      if (halo) haloLayerRef.current = halo.group;

      const fill = L.geoJSON(collection as any, {
        pane: 'boundariesPane',
        renderer,
        // Taps pass straight through to the map, which drops the destination
        // pin and reads this parcel's rules out of the collection in memory.
        interactive: false,
        style: (feature: any) => parcelStyle(feature, centreLat, currentZoom, overview)
      } as RenderedGeoJSONOptions);
      fillLayerRef.current = fill;

      // A compositor blur turns the discrete rings into a continuous gradient.
      // This replaced an SVG filter over the whole pane, which forced a full
      // repaint of every polygon on every frame of a pan.
      if (pane) {
        pane.style.filter =
          halo && halo.widest > 0 ? `blur(${edgeBlurPx(halo.widest).toFixed(1)}px)` : '';
      }

      boundaryLayerRef.current = L.layerGroup(
        halo ? [halo.group, fill] : [fill]
      ).addTo(map);
      renderSignatureRef.current = signature;
      renderedCollectionRef.current = collection;
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

      // Below the overview floor the whole hemisphere is on screen and there
      // is nothing legible to draw at any level of generalisation.
      if (currentZoom < BOUNDARY_OVERVIEW_MIN_ZOOM) {
        setZoomTooFar(true);
        setIsOverviewTier(false);
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
       * Zooming out used to erase every boundary, so the answer to "roughly
       * where is the public land?" was a blank continent. The overview draws
       * the big parcels as hairlines instead — and because it is asked for on
       * a very coarse grid and cached for the session, it is fetched once and
       * then simply panned around.
       */
      const detail: BoundaryDetail = currentZoom < BOUNDARY_MIN_ZOOM ? 'overview' : 'full';
      setZoomTooFar(false);
      setIsOverviewTier(detail === 'overview');

      const b = map.getBounds();
      const view: BoundingBox = {
        minLat: b.getSouth(), minLon: b.getWest(),
        maxLat: b.getNorth(), maxLon: b.getEast()
      };

      const tier = detail === 'overview' ? overviewMinAreaSqKm(currentZoom) : 0;
      const loaded = loadedBoxRef.current;
      const sameTier =
        loadedDetailRef.current === detail &&
        (detail === 'full' || overviewTierRef.current === tier);

      // Everything in view is already loaded at this detail level.
      if (loaded && sameTier && boxContains(loaded, view)) {
        // Panning inside loaded data needs nothing. A zoom change inside it
        // needs the uncertainty band rewidened, which `render` does without
        // rebuilding the parcels — and in the overview, not even that.
        if (detail === 'full' && currentZoom > loadedZoomRef.current) {
          // Zoomed past the detail we fetched for: go and get finer geometry.
        } else {
          render(collectionRef.current, detail);
          return;
        }
      }

      const box = detail === 'overview'
        ? overviewBoxFor(view, currentZoom)
        : requestBoxFor(view, currentZoom);
      const myId = ++requestId;
      controller?.abort();
      controller = new AbortController();
      setIsLoadingBoundaries(true);

      const collection = await fetchBoundaries(box, controller.signal, detail, currentZoom);
      if (cancelled || myId !== requestId) return;

      setIsLoadingBoundaries(false);
      // `null` means the request was superseded. Keep what is on screen rather
      // than blanking the map between one viewport and the next.
      if (!collection) return;

      loadedBoxRef.current = box;
      loadedZoomRef.current = currentZoom;
      loadedDetailRef.current = detail;
      overviewTierRef.current = tier;
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

    return () => {
      cancelled = true;
      controller?.abort();
      if (debounce) clearTimeout(debounce);
      map.off('moveend zoomend', load);
      clearLayer();
      if (boundaryRendererRef.current) {
        try { map.removeLayer(boundaryRendererRef.current); } catch { /* detached */ }
        boundaryRendererRef.current = null;
      }
    };
  }, [isMapReady, showBoundaries, isOfflineMode]);

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
      // Mid-route, a stray tap must not silently retarget the navigation.
      if (navigatingRef.current) return;

      const { lat, lng } = event.latlng;

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

    if (isOfflineMode) { clear(); setHazardReports([]); return; }

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
      setHazardReports(records);
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
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const clear = () => {
      if (!destinationMarkerRef.current) return;
      try { map.removeLayer(destinationMarkerRef.current); } catch { /* detached */ }
      destinationMarkerRef.current = null;
    };

    clear();
    if (!destination || destination.campsite) return;

    destinationMarkerRef.current = L.marker(
      [destination.latitude, destination.longitude],
      { icon: buildDestinationIcon(), title: 'Your chosen spot', zIndexOffset: 900 }
    ).addTo(map);

    return clear;
  }, [destination, isMapReady]);

  /* ------------------------------------------------------------------ */
  /* Navigation: the route line, and who else is out there               */
  /* ------------------------------------------------------------------ */
  /**
   * The route, drawn as a casing and a line so it reads over any base map.
   *
   * A single stroke disappears against a river on the topo layer and against
   * a road on satellite. The dark casing underneath is what keeps it legible
   * without having to shout with colour.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const clear = () => {
      if (!routeLayerRef.current) return;
      try { map.removeLayer(routeLayerRef.current); } catch { /* detached */ }
      routeLayerRef.current = null;
    };

    clear();
    if (!isNavigating || !route?.ok || route.geometry.length < 2) return;

    if (!map.getPane('routePane')) {
      map.createPane('routePane');
      const pane = map.getPane('routePane');
      // Above the boundaries, below every marker.
      if (pane) { pane.style.zIndex = '500'; pane.style.pointerEvents = 'none'; }
    }

    const group = L.layerGroup([], { pane: 'routePane' });
    group.addLayer(
      L.polyline(route.geometry, {
        pane: 'routePane', interactive: false,
        color: '#0F172A', weight: 11, opacity: 0.55, lineCap: 'round', lineJoin: 'round'
      })
    );
    group.addLayer(
      L.polyline(route.geometry, {
        pane: 'routePane', interactive: false,
        color: '#34D399', weight: 5.5, opacity: 0.95, lineCap: 'round', lineJoin: 'round'
      })
    );

    routeLayerRef.current = group.addTo(map);

    /**
     * Frame the whole drive when you set off.
     *
     * Without this the map sits wherever it was when you tapped Navigate,
     * which after a tap near the edge of the screen can be a view containing
     * neither end of the route. The bottom padding is generous because the HUD
     * covers the lower third of the screen and a route framed underneath it is
     * a route you cannot see.
     */
    try {
      map.fitBounds(L.latLngBounds(route.geometry), {
        paddingTopLeft: [36, 36],
        paddingBottomRight: [36, 260],
        animate: true
      });
    } catch { /* degenerate geometry — leave the view alone */ }

    return clear;
    // `route.geometry` identity is what actually matters; a new RouteResult
    // object with the same line should not re-frame the map underneath someone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route?.geometry, isNavigating, isMapReady]);

  /**
   * Everyone else on the road.
   *
   * Friends are named and wear their own rig. Everyone else is a muted dot
   * with no name — and note that "no name" is a display decision: the handle
   * is in the response, the server only guarantees the ~1 km position
   * coarsening. The legend says "names hidden" rather than "anonymous"
   * because that is the claim we can actually stand behind.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const clear = () => {
      if (!camperLayerRef.current) return;
      try { map.removeLayer(camperLayerRef.current); } catch { /* detached */ }
      camperLayerRef.current = null;
    };

    clear();
    if (!isNavigating || nearbyCampers.length === 0) return;

    if (!map.getPane('camperPane')) {
      map.createPane('camperPane');
      const pane = map.getPane('camperPane');
      if (pane) pane.style.zIndex = '640';
    }

    const group = L.layerGroup([], { pane: 'camperPane' });
    nearbyCampers.forEach((camper) => {
      if (typeof camper.approx_lat !== 'number' || typeof camper.approx_lon !== 'number') return;
      const isFriend = friendIds?.has(camper.user_id) ?? false;

      group.addLayer(
        L.marker([camper.approx_lat, camper.approx_lon], {
          pane: 'camperPane',
          icon: buildCamperIcon({
            emoji: isFriend && camper.rig_type
              ? RIG_AVATAR[camper.rig_type].emoji
              : isFriend ? UNKNOWN_RIG_EMOJI : '•',
            name: isFriend ? camper.handle : undefined
          }),
          title: isFriend
            ? `${camper.handle} — position accurate to about a kilometre`
            : 'A camper nearby — name hidden, position accurate to about a kilometre'
        })
      );
    });

    camperLayerRef.current = group.addTo(map);
    return clear;
  }, [isNavigating, nearbyCampers, friendIds, isMapReady]);

  /* ------------------------------------------------------------------ */
  /* Fire, flood and storm alerts                                        */
  /* ------------------------------------------------------------------ */
  /**
   * Active alerts drawn as warning triangles over the area they cover.
   *
   * Only alerts the feed gave a geometry for can be placed. NWS sends
   * `geometry: null` for its zone-based products, and those are counted and
   * reported rather than dropped silently or, worse, pinned to a guessed
   * location — a fire warning shown over the wrong valley is actively
   * dangerous. The count of unplaceable alerts is surfaced in the status chip.
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
      setUnmappableHazards(0);
      return;
    }

    if (!map.getPane('hazardPane')) {
      map.createPane('hazardPane');
      const pane = map.getPane('hazardPane');
      // Above campsite pins (600): a fire warning outranks a camping spot.
      if (pane) pane.style.zIndex = '620';
    }

    let cancelled = false;
    let controller: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const popupHtml = (alert: HazardAlert): string => {
      const style = HAZARD_STYLE[alert.family] ?? HAZARD_STYLE.other;
      const expires = alert.expires
        ? `<div style="color:#64748B;font-size:10px;margin-top:6px">Until ${new Date(
            alert.expires
          ).toLocaleString()}</div>`
        : '';
      const instruction = alert.instruction
        ? `<div style="margin-top:8px;padding:6px;border-radius:6px;background:#FEF3C7;border:1px solid #FCD34D;color:#92400E;font-size:10px;line-height:1.35">${alert.instruction}</div>`
        : '';

      return `<div style="font-family:system-ui;font-size:12px;min-width:220px;max-width:300px">
          <span style="display:inline-block;padding:2px 6px;border-radius:6px;background:${
            style.color
          };color:#0F172A;font-weight:700;font-size:10px;text-transform:uppercase">${
        style.label
      } · ${alert.severity}</span>
          <strong style="display:block;font-size:13px;margin-top:6px">${alert.event}</strong>
          <div style="color:#334155;margin-top:2px">${alert.headline ?? ''}</div>
          <div style="color:#475569;font-size:10px;margin-top:6px">${alert.areaDescription ?? ''}</div>
          ${instruction}
          <div style="color:#64748B;font-size:10px;margin-top:6px">Issued by ${alert.sender}</div>
          ${expires}
        </div>`;
    };

    const render = (alerts: HazardAlert[]) => {
      clear();
      const placeable = alerts.filter((a) => Array.isArray(a.centroid) && a.geometry);
      if (placeable.length === 0) return;

      const group = L.layerGroup([], { pane: 'hazardPane' });

      placeable.forEach((alert) => {
        const style = HAZARD_STYLE[alert.family] ?? HAZARD_STYLE.other;

        // The area itself, faint, so the triangle has visible extent.
        group.addLayer(
          L.geoJSON(alert.geometry as any, {
            pane: 'hazardPane',
            interactive: false,
            style: {
              color: style.color,
              weight: 1.5,
              opacity: 0.7,
              fillColor: style.color,
              fillOpacity: 0.12
            }
          })
        );

        const marker = L.marker(alert.centroid as [number, number], {
          pane: 'hazardPane',
          icon: buildHazardIcon(alert),
          title: `${alert.event} — ${alert.areaDescription}`,
          riseOnHover: true
        });
        marker.bindPopup(() => popupHtml(alert));
        group.addLayer(marker);
      });

      hazardLayerRef.current = group.addTo(map);
    };

    const run = async () => {
      const b = map.getBounds();
      controller?.abort();
      controller = new AbortController();

      const alerts = await fetchAreaAlerts(
        { minLat: b.getSouth(), minLon: b.getWest(), maxLat: b.getNorth(), maxLon: b.getEast() },
        controller.signal
      );
      if (cancelled) return;

      const sorted = sortAlerts(alerts);
      setHazards(sorted);
      setUnmappableHazards(sorted.filter((a) => !a.centroid || !a.geometry).length);
      render(sorted);
    };

    const load = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(run, 600);
    };

    load();
    map.on('moveend zoomend', load);

    return () => {
      cancelled = true;
      controller?.abort();
      if (debounce) clearTimeout(debounce);
      map.off('moveend zoomend', load);
      clear();
    };
  }, [isMapReady, isOfflineMode]);

  /* ------------------------------------------------------------------ */
  /* Markers                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * Only camper-submitted spots get a pin.
   *
   * The curated rows and the OpenStreetMap nodes are still in the app — they
   * fill the list view, they are searchable, and they are still the thing the
   * filters filter. They just don't put a marker on the map any more, because
   * a marker asserts "somebody was here" and those two sources assert
   * "a database says there is public land around here", which the boundary
   * polygons already say, more honestly, at their true resolution.
   */
  const pinnedCampsites = React.useMemo(
    () => campsites.filter((site) => site.source === 'user_submitted'),
    [campsites]
  );

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
        const text = count < 100 ? 'text-xs' : 'text-[11px]';

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
        icon: buildCampsiteIcon(selectedIdRef.current === site.id),
        title: `${site.name} — added by a camper`
      });
      marker.on('click', () => onSelectCampsite(site));
      marker.on('dblclick', () => onOpenDetailModal(site));
      markersRef.current.set(site.id, marker);
      return marker;
    });

    // One bulk insert. Adding markers one at a time re-clusters the whole
    // group on every single one.
    cluster.addLayers(markers);

    map.addLayer(cluster);
    clusterRef.current = cluster;
  }, [pinnedCampsites, isMapReady, onSelectCampsite, onOpenDetailModal]);

  // Swap only the two icons that changed.
  useEffect(() => {
    const previousId = selectedIdRef.current;
    const nextId = selectedCampsite?.id ?? null;
    if (previousId === nextId) return;

    markersRef.current.get(previousId ?? '')?.setIcon(buildCampsiteIcon(false));
    if (nextId) markersRef.current.get(nextId)?.setIcon(buildCampsiteIcon(true));
    selectedIdRef.current = nextId;
  }, [selectedCampsite]);

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

    /**
     * A blue dot when you're browsing, your camper when you're driving.
     *
     * Navigation is the one time the map is being read at a glance from a
     * driver's seat, and a dot identical to every other blue dot in every
     * other app is the wrong thing to hunt for. The camper is deliberately
     * larger than it needs to be.
     */
    const icon = isNavigating
      ? L.divIcon({
          className: 'user-camper-marker',
          html: `
            <div class="relative flex items-center justify-center">
              <span class="absolute w-14 h-14 rounded-full bg-emerald-400/20 anim-pulse"></span>
              <span class="relative flex items-center justify-center w-11 h-11 rounded-full bg-slate-900 border-2 border-emerald-400 shadow-xl">
                ${SELF_CAMPER_SVG}
              </span>
            </div>`,
          iconSize: [44, 44],
          iconAnchor: [22, 22]
        })
      : L.divIcon({
          className: 'user-location-marker',
          html: `
            <div class="relative flex items-center justify-center">
              <div class="absolute w-12 h-12 bg-blue-500/20 rounded-full animate-ping"></div>
              <div class="w-4 h-4 bg-blue-500 border-2 border-white rounded-full shadow-lg relative z-10"></div>
            </div>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        });

    userMarkerRef.current = L.marker(userLocation, {
      icon,
      zIndexOffset: isNavigating ? 1000 : 0
    }).addTo(map);
  }, [userLocation, isMapReady, isNavigating]);

  /* ------------------------------------------------------------------ */
  /* Recentre                                                            */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    // Leaflet clamps to minZoom and maxBounds internally, so a request to fly
    // somewhere outside the world simply lands at the nearest valid view.
    try {
      map.flyTo(center, zoom, { duration: 1.2 });
    } catch {
      try { map.setView(center, zoom); } catch { /* not ready */ }
    }
  }, [center, zoom, isMapReady]);

  const statusText = useCallback((): string => {
    if (!showBoundaries) return 'Land boundaries hidden';
    if (zoomTooFar) return 'Zoom in for land boundaries';
    if (isLoadingBoundaries) return 'Loading boundaries…';
    // The overview shows only the big parcels, so it has to say so. Otherwise
    // a camper zoomed out over a region full of small BLM sections would read
    // a near-empty map as "nothing here", which is the exact misreading this
    // app exists to avoid.
    if (isOverviewTier) {
      return boundaries.features.length > 0
        ? `${boundaries.features.length} large parcels · zoom in for the rest`
        : 'No large parcels here · zoom in for smaller ones';
    }
    // "edges approximate" rides along with the count so the caveat is on
    // screen even when the legend below is collapsed.
    if (boundaries.features.length > 0) {
      return `${boundaries.features.length} parcels · edges approximate`;
    }
    return 'No mapped public land in view';
  }, [showBoundaries, zoomTooFar, isLoadingBoundaries, isOverviewTier, boundaries.features.length]);

  /** Only worth expanding when there is a per-source breakdown to show. */
  const hasLegend = !isOfflineMode && showBoundaries && boundaries.features.length > 0;

  return (
    <div className="relative w-full h-full bg-slate-950 overflow-hidden" ref={containerRef}>
      {/*
        Status + legend.

        This is one collapsed chip by default. It used to be a permanently
        expanded panel listing every source plus a paragraph about edge
        accuracy, which on a phone covered most of the map it was describing —
        a legend that hides the thing it explains.

        What it must never do is drop the caveat. The collapsed chip always
        carries "edges approximate", the faded band is drawn on the map itself,
        and the full explanation is one tap away and repeated in every parcel's
        popup. The detail is quieter, not absent.
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
      <div className="absolute top-3 left-3 z-[1000] flex flex-col gap-1 max-w-[min(16rem,calc(100%-5rem))]">
        {isOfflineMode ? (
          <div className="bg-amber-500 text-slate-950 px-3 py-1.5 rounded-xl font-bold text-xs shadow-xl flex items-center gap-2 border border-amber-300">
            <span className="w-2 h-2 rounded-full bg-slate-950 animate-ping" />
            Offline — saved maps and spots
          </div>
        ) : (
          <div className="bg-slate-900/90 backdrop-blur-md border border-slate-700/80 rounded-xl shadow-xl anim-in-down overflow-hidden">
            <button
              type="button"
              onClick={() => hasLegend && setShowLegend((open) => !open)}
              // Nothing to open when there are no parcels to break down.
              className={`w-full px-3 py-1.5 flex items-center gap-2 text-left text-xs font-semibold text-slate-200 ${
                hasLegend ? 'hover:bg-slate-800/60' : 'cursor-default'
              }`}
              aria-expanded={hasLegend ? showLegend : undefined}
              disabled={!hasLegend}
            >
              {isLoadingBoundaries ? (
                <Loader2 className="w-3.5 h-3.5 text-emerald-400 animate-spin shrink-0" />
              ) : (
                <Shield
                  className={`w-3.5 h-3.5 shrink-0 ${
                    boundaries.features.length > 0 ? 'text-emerald-400' : 'text-slate-500'
                  }`}
                />
              )}
              <span className="min-w-0 truncate">{statusText()}</span>
              {hasLegend && (
                <ChevronDown
                  className={`w-3.5 h-3.5 ml-auto shrink-0 text-slate-400 transition-moook ${
                    showLegend ? 'rotate-180' : ''
                  }`}
                />
              )}
            </button>

            {hasLegend && showLegend && (
              <div className="px-3 pb-2 pt-0.5 border-t border-slate-700/60 anim-in-down">
                {boundaries.meta.sources
                  .filter((source) => source.featureCount > 0)
                  .map((source) => {
                    const style = BOUNDARY_STYLES[source.confidence];
                    return (
                      <div key={source.id} className="flex items-center gap-2 py-0.5">
                        <span
                          className="w-3 h-3 rounded-sm border shrink-0"
                          style={{ backgroundColor: style.fillColor, borderColor: style.color }}
                        />
                        {/* Name the source, not its confidence tier. Several
                            sources share a tier, so the tier label would show
                            Alberta Crown Land as "Federal land (BLM / USFS)". */}
                        <span className="text-[10px] text-slate-300 font-semibold truncate">
                          {source.label}
                        </span>
                        <span className="text-[10px] text-slate-500 ml-auto">
                          {source.featureCount}
                        </span>
                      </div>
                    );
                  })}

                <div className="mt-1.5 pt-1.5 border-t border-slate-700/60">
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="w-3 h-3 rounded-sm shrink-0"
                      style={{
                        background:
                          'linear-gradient(90deg, rgba(148,163,184,0.05), rgba(148,163,184,0.45))'
                      }}
                    />
                    <span className="text-[10px] text-slate-400 font-semibold">
                      Uncertainty band
                    </span>
                  </div>
                  {/*
                    The numbers come from UNCERTAINTY_METRES rather than being
                    typed here, so the figure the legend quotes can never drift
                    away from the band actually being drawn.

                    This is also where the per-parcel accuracy note went when
                    the popups were cut back to the land's name and its rules.
                    The caveat is stated once, permanently, instead of in every
                    popup — but it is still stated.
                  */}
                  <p className="text-[9px] text-slate-500 leading-tight">
                    Edges are drawn as a fade, not a line, because no source here is
                    survey-grade — roughly {UNCERTAINTY_LABEL.cadastral_derived} to{' '}
                    {UNCERTAINTY_LABEL.generalised} depending on the source. Inside the
                    fade you may be on either side of the real boundary. Not permission
                    to camp.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {hazards.length > 0 && (
          <div className="bg-amber-950/90 backdrop-blur-md border border-amber-600/70 rounded-xl px-3 py-1.5 shadow-xl anim-in-up">
            <div className="flex items-center gap-2 text-[11px] font-semibold text-amber-200">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>
                {hazards.length} active alert{hazards.length === 1 ? '' : 's'} here
              </span>
            </div>
            {/* Said out loud rather than quietly dropped: some alerts arrive
                with no area attached, and guessing one would be worse. */}
            {unmappableHazards > 0 && (
              <p className="text-[9px] text-amber-300/80 leading-tight mt-0.5">
                {unmappableHazards} not shown on the map — no area given. Open the
                site details to read {unmappableHazards === 1 ? 'it' : 'them'}.
              </p>
            )}
          </div>
        )}

        {/*
          Camper reports are counted separately from official alerts, and
          worded so the difference is unmissable. These are people's accounts
          of a road; the amber chip above is an agency's warning about weather.
        */}
        {hazardReports.length > 0 && (
          <div className="bg-slate-900/90 backdrop-blur-md border border-slate-600/70 rounded-xl px-3 py-1.5 shadow-xl anim-in-up">
            <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-200">
              <span className="text-xs leading-none">📣</span>
              <span>
                {hazardReports.length} camper report
                {hazardReports.length === 1 ? '' : 's'} nearby
              </span>
            </div>
            <p className="text-[9px] text-slate-400 leading-tight mt-0.5">
              Reported by other campers, not verified. Tap one to see how many
              people have confirmed it.
            </p>
          </div>
        )}

        {!isWithinCoverage(center[0], center[1]) && (
          <div className="bg-slate-800/95 backdrop-blur-md border border-slate-600 text-slate-300 px-3 py-1.5 rounded-xl text-[11px] font-semibold shadow-xl flex items-start gap-2 anim-in-up">
            <Eye className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
            <span>Outside coverage. Wandrlust supports {COVERAGE_LABEL}.</span>
          </div>
        )}
      </div>

      {/* Layer controls */}
      <div className="absolute top-3 right-3 z-[1000] flex flex-col items-end gap-2">
        <button
          type="button"
          onClick={() => setShowLayerMenu((open) => !open)}
          className="p-2 rounded-xl bg-slate-900/90 backdrop-blur-md border border-slate-700/80 text-slate-200 hover:text-white shadow-xl"
          aria-label="Map layers"
          aria-expanded={showLayerMenu}
        >
          <Layers className="w-4 h-4" />
        </button>

        {showLayerMenu && (
          <div className="bg-slate-900/95 backdrop-blur-md border border-slate-700/80 rounded-xl p-2 shadow-2xl w-48 anim-in-down">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold px-1 pb-1">Base map</p>
            {(Object.keys(TILE_URLS) as MapTileLayer[]).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTileLayer(id)}
                className={`w-full text-left px-2 py-1.5 rounded-lg text-xs font-semibold ${
                  activeTileLayer === id ? 'bg-emerald-600 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                {TILE_URLS[id].label}
              </button>
            ))}

            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold px-1 pt-2 pb-1">Overlays</p>
            <label className="flex items-center justify-between px-2 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
              <span>Public land boundaries</span>
              <input
                type="checkbox"
                checked={showBoundaries}
                onChange={(e) => setShowBoundaries(e.target.checked)}
                className="accent-emerald-500 w-3.5 h-3.5"
              />
            </label>
            {/* Only listed when the optional vector tileset is actually
                configured. A toggle that explains why it can't work is a
                developer's note sitting in a camper's map menu. */}
            {crownLandAvailable && (
              <label className="flex items-center justify-between px-2 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
                <span>Crown land tiles</span>
                <input
                  type="checkbox"
                  checked={showCrownLand}
                  onChange={(e) => setShowCrownLand(e.target.checked)}
                  className="accent-emerald-500 w-3.5 h-3.5"
                />
              </label>
            )}
          </div>
        )}

        {onLocateUser && (
          <button
            type="button"
            onClick={onLocateUser}
            disabled={isLocating}
            className="p-2 rounded-xl bg-slate-900/90 backdrop-blur-md border border-slate-700/80 text-slate-200 hover:text-white shadow-xl disabled:opacity-50"
            aria-label="Centre on my location"
          >
            {isLocating
              ? <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
              : <Crosshair className="w-4 h-4" />}
          </button>
        )}
      </div>

      {/*
        The one instruction on the map.

        Shown only until the user has picked somewhere, and never while
        navigating. A tap target that covers the entire screen is invisible
        until somebody tells you it's there — but once you know, the hint is
        clutter, so it removes itself.
      */}
      {!destination && !isNavigating && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-[999] pointer-events-none anim-in-up">
          <div className="flex items-center gap-2 px-3.5 py-2 rounded-full bg-slate-900/85 backdrop-blur-md border border-slate-700/70 shadow-xl">
            <MousePointerClick className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span className="text-[11px] font-semibold text-slate-200">
              Tap anywhere to pick a spot
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
