import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.vectorgrid';
import { ChevronDown, Crosshair, Eye, Layers, Loader2, Shield } from 'lucide-react';

import type { Campsite, LandType, MapTileLayer } from '../types';
import { getCachedTile } from '../services/offlineStorage';
import {
  fetchBoundaries, requestBoxFor, boxContains, BOUNDARY_STYLES, EMPTY_BOUNDARIES,
  BoundaryCollection, BoundaryConfidence, BoundaryFeature,
  EDGE_ACCURACY_COPY, CAMPING_BASIS_COPY, EdgeAccuracy, CampingBasisKind
} from '../services/boundaryService';
import {
  buildFuzzRings, ringBudget, edgeBlurPx,
  UNCERTAINTY_LABEL, uncertaintyCaution, shouldSimplify
} from '../utils/fuzzyBoundary';
import {
  BoundingBox, COVERAGE_OUTLINE, WORLD_RING, BOUNDARY_MIN_ZOOM,
  COVERAGE_LABEL, isWithinCoverage
} from '../config/coverage';

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
  /** Extra ring of tiles held off-screen so a short pan has nothing to fetch. */
  keepBuffer: 3
} as const;

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

const LAND_TYPE_COLOR: Record<LandType, string> = {
  blm: '#F59E0B',
  usfs: '#10B981',
  state_forest: '#8B5CF6',
  crown_land: '#06B6D4',
  dispersed: '#8B5CF6'
};

const LAND_TYPE_BADGE: Record<LandType, string> = {
  blm: 'BLM',
  usfs: 'USFS',
  state_forest: 'STATE',
  crown_land: 'CROWN',
  dispersed: 'SPOT'
};

/** Pin markup. Extracted so selection can swap an icon without a full rebuild. */
const buildMarkerIcon = (site: Campsite, isSelected: boolean): L.DivIcon =>
  L.divIcon({
    className: 'custom-campsite-marker',
    html: `
      <div class="relative flex items-center justify-center ${isSelected ? 'scale-125 z-50' : 'z-10'}">
        <div class="w-8 h-8 rounded-full flex items-center justify-center shadow-xl border-2 ${
          isSelected ? 'border-white ring-4 ring-emerald-400/50' : 'border-slate-900'
        }" style="background-color:${LAND_TYPE_COLOR[site.landType]}">
          <svg class="w-4 h-4 text-slate-950 stroke-[2.5]" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M19 20 12 4 5 20" /><path d="M12 4v16" /><path d="M2 20h20" />
          </svg>
        </div>
        <div class="absolute -top-2 -right-2 px-1 text-[9px] font-black tracking-tighter text-white bg-slate-950 rounded-full border border-slate-700 shadow">
          ${LAND_TYPE_BADGE[site.landType]}
        </div>
      </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });

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
}

export const MapComponent: React.FC<MapComponentProps> = ({
  campsites, selectedCampsite, onSelectCampsite, center, zoom, userLocation,
  isOfflineMode, onOpenDetailModal, onLocateUser,
  isLocating = false
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const userMarkerRef = useRef<L.Marker | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const boundaryLayerRef = useRef<L.LayerGroup | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  // What boundary data we already hold, so a pan inside it costs nothing.
  const loadedBoxRef = useRef<BoundingBox | null>(null);
  const loadedZoomRef = useRef<number>(0);
  const renderedZoomRef = useRef<number>(0);
  const collectionRef = useRef<BoundaryCollection>(EMPTY_BOUNDARIES);
  const boundaryRendererRef = useRef<L.Canvas | null>(null);

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

    // A world-sized polygon with the supported region punched out of it. Now
    // that the tile layer no longer repeats, this covers everything outside
    // coverage exactly once.
    const mask = L.polygon([toLatLng(WORLD_RING), toLatLng(COVERAGE_OUTLINE)], {
      pane: 'coveragePane', interactive: false, stroke: true,
      color: '#475569', weight: 1, fillColor: '#0F172A', fillOpacity: 0.72
    }).addTo(map);

    return () => { try { map.removeLayer(mask); } catch { /* detached */ } };
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
    };

    const forget = () => {
      loadedBoxRef.current = null;
      collectionRef.current = EMPTY_BOUNDARIES;
    };

    if (!showBoundaries || isOfflineMode) {
      clearLayer();
      forget();
      setBoundaries(EMPTY_BOUNDARIES);
      setZoomTooFar(false);
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

    const popupHtml = (properties: Record<string, any>): string => {
      const p = properties ?? {};
      const style = BOUNDARY_STYLES[p._confidence as BoundaryConfidence];
      const edgeNote = p._edgeAccuracy
        ? EDGE_ACCURACY_COPY[p._edgeAccuracy as EdgeAccuracy]
        : 'Boundary accuracy unknown.';
      const basisNote = p._campingBasisKind
        ? CAMPING_BASIS_COPY[p._campingBasisKind as CampingBasisKind]
        : 'Camping basis unknown.';
      const uncertainty = p._edgeAccuracy
        ? UNCERTAINTY_LABEL[p._edgeAccuracy as EdgeAccuracy]
        : 'unknown';
      const caution = p._edgeAccuracy
        ? uncertaintyCaution(p._edgeAccuracy as EdgeAccuracy)
        : 'Edge accuracy is unknown for this source. Treat the boundary as approximate.';

      return `<div style="font-family:system-ui;font-size:12px;min-width:230px;max-width:300px">
           <strong style="font-size:13px">${p._name ?? 'Public land'}</strong><br/>
           <span style="color:#334155">${p._designation ?? ''}</span><br/>
           <span style="display:inline-block;margin-top:6px;padding:2px 6px;border-radius:6px;background:${
             style?.fillColor ?? '#94A3B8'
           };color:#0F172A;font-weight:700;font-size:10px">${style?.label ?? 'Public land'}</span>
           <div style="margin-top:8px;padding-top:6px;border-top:1px solid #E2E8F0">
             <div style="color:#475569;font-size:10px;margin-bottom:4px"><strong>Edges:</strong> ${edgeNote}</div>
             <div style="color:#475569;font-size:10px"><strong>Camping:</strong> ${basisNote}</div>
           </div>
           <span style="color:#64748B;font-size:10px;display:block;margin-top:6px">Source: ${p._attribution ?? 'Unknown'}</span>
           <div style="margin-top:8px;padding:6px;border-radius:6px;background:#FEF3C7;border:1px solid #FCD34D">
             <div style="color:#92400E;font-size:10px;font-weight:700;margin-bottom:2px">Boundary uncertainty: ${uncertainty}</div>
             <div style="color:#92400E;font-size:10px;line-height:1.35">${caution}</div>
           </div>
           <span style="color:#B45309;font-size:10px;display:block;margin-top:6px;font-weight:600">Not survey-grade, and not a legal boundary. Only a licensed survey establishes property lines.</span>
         </div>`;
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
    const render = (collection: BoundaryCollection) => {
      clearLayer();
      const pane = boundaryPane();
      renderedZoomRef.current = map.getZoom();
      if (collection.features.length === 0) {
        if (pane) pane.style.filter = '';
        return;
      }

      const centreLat = map.getCenter().lat;
      const currentZoom = map.getZoom();
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

      const haloGroup = L.layerGroup([], { pane: 'boundariesPane' });
      let widestBand = 0;

      bands.forEach(({ accuracy, color, features }) => {
        const ringSpecs = buildFuzzRings(accuracy, centreLat, currentZoom, rings);
        widestBand = Math.max(widestBand, ringSpecs[0]?.weight ?? 0);

        ringSpecs.forEach((ring) => {
          haloGroup.addLayer(
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

      const layer = L.geoJSON(collection as any, {
        pane: 'boundariesPane',
        renderer,
        style: (feature: any) => {
          const confidence: BoundaryConfidence =
            feature?.properties?._confidence ?? 'managing_agency';
          const style = BOUNDARY_STYLES[confidence] ?? BOUNDARY_STYLES.managing_agency;
          const accuracy: EdgeAccuracy = feature?.properties?._edgeAccuracy ?? 'administrative';
          return {
            color: style.color,
            fillColor: style.fillColor,
            fillOpacity: style.fillOpacity * 0.85,
            weight: shouldSimplify(accuracy, centreLat, currentZoom) ? 1 : 0,
            opacity: 0.5
          };
        },
        // Bound lazily: building a few hundred popup strings up front cost more
        // than drawing the polygons did, and most are never opened.
        onEachFeature: (feature: any, lyr: L.Layer) => {
          lyr.bindPopup(() => popupHtml(feature?.properties));
        }
      } as RenderedGeoJSONOptions);

      // A compositor blur turns the discrete rings into a continuous gradient.
      // This replaced an SVG filter over the whole pane, which forced a full
      // repaint of every polygon on every frame of a pan.
      if (pane) pane.style.filter = widestBand > 0 ? `blur(${edgeBlurPx(widestBand).toFixed(1)}px)` : '';

      boundaryLayerRef.current = L.layerGroup([haloGroup, layer]).addTo(map);
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

      if (currentZoom < BOUNDARY_MIN_ZOOM) {
        setZoomTooFar(true);
        setBoundaries(EMPTY_BOUNDARIES);
        forget();
        clearLayer();
        const pane = map.getPane('boundariesPane');
        if (pane) pane.style.filter = '';
        return;
      }
      setZoomTooFar(false);

      const b = map.getBounds();
      const view: BoundingBox = {
        minLat: b.getSouth(), minLon: b.getWest(),
        maxLat: b.getNorth(), maxLon: b.getEast()
      };

      // Everything in view is already loaded at this detail level. Panning
      // inside it costs nothing; only a zoom change needs a redraw, because
      // the band's pixel width is derived from the zoom.
      const loaded = loadedBoxRef.current;
      if (loaded && boxContains(loaded, view) && currentZoom <= loadedZoomRef.current) {
        if (currentZoom !== renderedZoomRef.current) render(collectionRef.current);
        return;
      }

      const box = requestBoxFor(view, currentZoom);
      const myId = ++requestId;
      controller?.abort();
      controller = new AbortController();
      setIsLoadingBoundaries(true);

      const collection = await fetchBoundaries(box, controller.signal);
      if (cancelled || myId !== requestId) return;

      setIsLoadingBoundaries(false);
      // `null` means the request was superseded. Keep what is on screen rather
      // than blanking the map between one viewport and the next.
      if (!collection) return;

      loadedBoxRef.current = box;
      loadedZoomRef.current = currentZoom;
      collectionRef.current = collection;
      setBoundaries(collection);
      render(collection);
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
  /* Markers                                                             */
  /* ------------------------------------------------------------------ */
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
      maxClusterRadius: 40,
      // Build the cluster tree in chunks across frames rather than in one
      // blocking pass, so a big result set can't freeze the map while it loads.
      chunkedLoading: true,
      removeOutsideVisibleBounds: true,
      iconCreateFunction: (c) =>
        L.divIcon({
          html: `<div class="w-8 h-8 rounded-full bg-slate-900 border-2 border-emerald-400 flex items-center justify-center text-white font-bold text-xs shadow-xl">${c.getChildCount()}</div>`,
          className: 'custom-cluster-icon',
          iconSize: [32, 32],
          iconAnchor: [16, 16]
        })
    });

    const markers = campsites.map((site) => {
      const marker = L.marker([site.latitude, site.longitude], {
        icon: buildMarkerIcon(site, selectedIdRef.current === site.id),
        title: site.name
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
  }, [campsites, isMapReady, onSelectCampsite, onOpenDetailModal]);

  // Swap only the two icons that changed.
  useEffect(() => {
    const previousId = selectedIdRef.current;
    const nextId = selectedCampsite?.id ?? null;
    if (previousId === nextId) return;

    if (previousId) {
      const previousSite = campsites.find((s) => s.id === previousId);
      const marker = markersRef.current.get(previousId);
      if (previousSite && marker) marker.setIcon(buildMarkerIcon(previousSite, false));
    }
    if (nextId && selectedCampsite) {
      markersRef.current.get(nextId)?.setIcon(buildMarkerIcon(selectedCampsite, true));
    }
    selectedIdRef.current = nextId;
  }, [selectedCampsite, campsites]);

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

    userMarkerRef.current = L.marker(userLocation, {
      icon: L.divIcon({
        className: 'user-location-marker',
        html: `
          <div class="relative flex items-center justify-center">
            <div class="absolute w-12 h-12 bg-blue-500/20 rounded-full animate-ping"></div>
            <div class="w-4 h-4 bg-blue-500 border-2 border-white rounded-full shadow-lg relative z-10"></div>
          </div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      })
    }).addTo(map);
  }, [userLocation, isMapReady]);

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
    // "edges approximate" rides along with the count so the caveat is on
    // screen even when the legend below is collapsed.
    if (boundaries.features.length > 0) {
      return `${boundaries.features.length} parcels · edges approximate`;
    }
    return 'No mapped public land in view';
  }, [showBoundaries, zoomTooFar, isLoadingBoundaries, boundaries.features.length]);

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
                  <p className="text-[9px] text-slate-500 leading-tight">
                    Edges are drawn as a fade, not a line, because no source here is
                    survey-grade. Inside the fade you may be on either side of the real
                    boundary. Not permission to camp.
                  </p>
                </div>
              </div>
            )}
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
            <label className="flex items-center justify-between px-2 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
              <span>
                Crown land tiles
                {!crownLandAvailable && (
                  <span className="block text-[9px] text-slate-500">needs a Mapbox token</span>
                )}
              </span>
              <input
                type="checkbox"
                checked={showCrownLand}
                onChange={(e) => setShowCrownLand(e.target.checked)}
                className="accent-emerald-500 w-3.5 h-3.5"
              />
            </label>
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

      {/* Selected pin preview */}
      {selectedCampsite && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[90%] max-w-sm z-[999] anim-in-up">
          <div className="bg-slate-900/95 backdrop-blur-md border border-slate-700/60 p-3 rounded-2xl shadow-2xl flex flex-col">
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: LAND_TYPE_COLOR[selectedCampsite.landType] }}
                  />
                  <span className="text-[11px] font-bold text-slate-300 tracking-wider">
                    {LAND_TYPE_BADGE[selectedCampsite.landType]}
                  </span>
                  <span className="text-slate-600">•</span>
                  <span className="text-[11px] text-slate-400 font-medium truncate">
                    {selectedCampsite.address.nearestCity}
                    {selectedCampsite.address.stateProvince && `, ${selectedCampsite.address.stateProvince}`}
                  </span>
                </div>
                <h3 className="font-['Outfit'] font-bold text-base text-slate-100 truncate">
                  {selectedCampsite.name}
                </h3>
              </div>
              <button
                onClick={() => onOpenDetailModal(selectedCampsite)}
                className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex items-center gap-1 shadow-md shadow-emerald-950 shrink-0"
              >
                <Eye className="w-3.5 h-3.5" />
                Details
              </button>
            </div>

            <div className="mt-2.5 flex items-center justify-between text-xs text-slate-300 border-t border-slate-800/80 pt-2">
              <span className="flex items-center gap-2">
                <span>
                  ⭐️ {selectedCampsite.rating > 0 ? selectedCampsite.rating.toFixed(1) : '—'}
                  {selectedCampsite.reviewCount > 0 && ` (${selectedCampsite.reviewCount})`}
                </span>
                <span>•</span>
                <span className="text-emerald-400 font-semibold">Public land</span>
              </span>
              <span className="text-[11px] text-slate-400">
                {selectedCampsite.amenities.stayLimitDays}d max stay
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
