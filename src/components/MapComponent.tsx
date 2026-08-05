import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.vectorgrid';
import { Crosshair, Eye, Layers, Loader2, Shield } from 'lucide-react';

import type { Campsite, LandType, MapTileLayer } from '../types';
import { getCachedTile } from '../services/offlineStorage';
import {
  fetchBoundaries, BOUNDARY_STYLES, EMPTY_BOUNDARIES,
  BoundaryCollection, BoundaryConfidence,
  EDGE_ACCURACY_COPY, CAMPING_BASIS_COPY, EdgeAccuracy, CampingBasisKind
} from '../services/boundaryService';
import {
  buildFuzzRings, ensureFuzzFilter, FUZZ_FILTER_ID,
  UNCERTAINTY_LABEL, uncertaintyCaution, shouldSimplify
} from '../utils/fuzzyBoundary';
import {
  COVERAGE_OUTLINE, WORLD_RING, BOUNDARY_MIN_ZOOM,
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
  onVisibleCampsitesChange?: (visibleSites: Campsite[]) => void;
  onLocateUser?: () => void;
  isLocating?: boolean;
}

export const MapComponent: React.FC<MapComponentProps> = ({
  campsites, selectedCampsite, onSelectCampsite, center, zoom, userLocation,
  isOfflineMode, onOpenDetailModal, onVisibleCampsitesChange, onLocateUser,
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

  const [activeTileLayer, setActiveTileLayer] = useState<MapTileLayer>('satellite');
  const [isMapReady, setIsMapReady] = useState(false);
  const [showCrownLand, setShowCrownLand] = useState(true);
  const [crownLandAvailable, setCrownLandAvailable] = useState(false);
  const [showLayerMenu, setShowLayerMenu] = useState(false);
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
      center, zoom, zoomControl: false, attributionControl: false
    });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);

    mapRef.current = map;
    setIsMapReady(true);

    // The container is often still being laid out on first paint.
    const timer = setTimeout(() => {
      try { map.invalidateSize(); } catch { /* not attached yet */ }
    }, 200);

    return () => {
      clearTimeout(timer);
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
      layer = new OfflineTileLayer('', { maxZoom: 19, attribution: 'Offline tile cache' });
    } else {
      const config = TILE_URLS[activeTileLayer];
      layer = L.tileLayer(config.url, { maxZoom: 19, attribution: config.attribution });
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

    // A world-sized polygon with the supported region punched out of it.
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

    if (!showBoundaries || isOfflineMode) {
      clearLayer();
      setBoundaries(EMPTY_BOUNDARIES);
      setZoomTooFar(false);
      return;
    }

    let cancelled = false;
    let controller: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const load = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        if (map.getZoom() < BOUNDARY_MIN_ZOOM) {
          setZoomTooFar(true);
          setBoundaries(EMPTY_BOUNDARIES);
          clearLayer();
          return;
        }
        setZoomTooFar(false);

        const b = map.getBounds();
        controller?.abort();
        controller = new AbortController();
        setIsLoadingBoundaries(true);

        const collection = await fetchBoundaries(
          { minLat: b.getSouth(), minLon: b.getWest(), maxLat: b.getNorth(), maxLon: b.getEast() },
          controller.signal
        );
        if (cancelled) return;

        setBoundaries(collection);
        setIsLoadingBoundaries(false);
        clearLayer();
        if (collection.features.length === 0) return;

        if (!map.getPane('boundariesPane')) {
          map.createPane('boundariesPane');
          const pane = map.getPane('boundariesPane');
          if (pane) pane.style.zIndex = '390';
        }

        /* ---- Fuzzy edge rendering ---------------------------------------
         * We never draw a crisp boundary line. Each polygon gets a soft fill
         * plus a stack of translucent strokes whose total width equals the
         * dataset's real positional uncertainty, converted from metres to
         * pixels at the current zoom. A hard line would claim a precision
         * none of these sources have, and the failure mode is somebody
         * parking on private land.
         */
        ensureFuzzFilter();
        const centreLat = map.getCenter().lat;
        const currentZoom = map.getZoom();

        const haloGroup = L.layerGroup([], { pane: 'boundariesPane' });

        const layer = L.geoJSON(collection as any, {
          pane: 'boundariesPane',
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
          onEachFeature: (feature: any, lyr: L.Layer) => {
            const p = feature?.properties ?? {};
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

            lyr.bindPopup(
              `<div style="font-family:system-ui;font-size:12px;min-width:230px;max-width:300px">
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
               </div>`
            );
          }
        });

        // The feathered band: one translucent stroke per ring, stacked
        // widest-first so the edge fades outward into nothing.
        collection.features.forEach((feature: any) => {
          const accuracy: EdgeAccuracy = feature?.properties?._edgeAccuracy ?? 'administrative';
          if (shouldSimplify(accuracy, centreLat, currentZoom)) return;

          const confidence: BoundaryConfidence = feature?.properties?._confidence ?? 'managing_agency';
          const style = BOUNDARY_STYLES[confidence] ?? BOUNDARY_STYLES.managing_agency;

          buildFuzzRings(accuracy, centreLat, currentZoom).forEach((ring) => {
            haloGroup.addLayer(
              L.geoJSON(feature, {
                pane: 'boundariesPane',
                interactive: false,
                style: {
                  color: style.color, weight: ring.weight, opacity: ring.opacity,
                  fill: false, lineJoin: 'round', lineCap: 'round'
                }
              })
            );
          });
        });

        // Gaussian blur turns the discrete rings into a continuous gradient.
        const pane = map.getPane('boundariesPane');
        if (pane) pane.style.filter = `url(#${FUZZ_FILTER_ID})`;

        boundaryLayerRef.current = L.layerGroup([haloGroup, layer]).addTo(map);
      }, 500);
    };

    load();
    map.on('moveend zoomend', load);

    return () => {
      cancelled = true;
      controller?.abort();
      if (debounce) clearTimeout(debounce);
      map.off('moveend zoomend', load);
    };
  }, [isMapReady, showBoundaries, isOfflineMode]);

  /* ------------------------------------------------------------------ */
  /* Which campsites are on screen                                       */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady || !onVisibleCampsitesChange) return;

    const report = () => {
      try {
        const bounds = map.getBounds();
        onVisibleCampsitesChange(
          campsites.filter((site) => bounds.contains([site.latitude, site.longitude]))
        );
      } catch { /* map not laid out yet */ }
    };

    report();
    map.on('moveend zoomend', report);
    return () => { map.off('moveend zoomend', report); };
  }, [campsites, isMapReady, onVisibleCampsitesChange]);

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
      iconCreateFunction: (c) =>
        L.divIcon({
          html: `<div class="w-8 h-8 rounded-full bg-slate-900 border-2 border-emerald-400 flex items-center justify-center text-white font-bold text-xs shadow-xl">${c.getChildCount()}</div>`,
          className: 'custom-cluster-icon',
          iconSize: [32, 32],
          iconAnchor: [16, 16]
        })
    });

    campsites.forEach((site) => {
      const marker = L.marker([site.latitude, site.longitude], {
        icon: buildMarkerIcon(site, selectedIdRef.current === site.id),
        title: site.name
      });
      marker.on('click', () => onSelectCampsite(site));
      marker.on('dblclick', () => onOpenDetailModal(site));
      cluster.addLayer(marker);
      markersRef.current.set(site.id, marker);
    });

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
    try {
      map.flyTo(center, zoom, { duration: 1.2 });
    } catch {
      try { map.setView(center, zoom); } catch { /* not ready */ }
    }
  }, [center, zoom, isMapReady]);

  const statusText = useCallback((): string => {
    if (!showBoundaries) return 'Land boundaries hidden';
    if (zoomTooFar) return 'Zoom in to load land boundaries';
    if (isLoadingBoundaries) return 'Loading public land boundaries…';
    if (boundaries.features.length > 0) return `${boundaries.features.length} land parcels in view`;
    return 'No mapped public land in view';
  }, [showBoundaries, zoomTooFar, isLoadingBoundaries, boundaries.features.length]);

  return (
    <div className="relative w-full h-full min-h-[400px] bg-slate-950 overflow-hidden" ref={containerRef}>
      {/* Status + legend */}
      <div className="absolute top-3 left-3 z-[400] flex flex-col gap-1">
        {isOfflineMode ? (
          <div className="bg-amber-500 text-slate-950 px-3 py-1.5 rounded-xl font-bold text-xs shadow-xl flex items-center gap-2 border border-amber-300">
            <span className="w-2 h-2 rounded-full bg-slate-950 animate-ping" />
            Offline — showing your saved maps and spots
          </div>
        ) : (
          <div className="bg-slate-900/90 backdrop-blur-md text-slate-200 px-3 py-1.5 rounded-xl text-xs font-semibold shadow-xl flex items-center gap-2 border border-slate-700/80 anim-in-down">
            {isLoadingBoundaries ? (
              <Loader2 className="w-3.5 h-3.5 text-emerald-400 animate-spin" />
            ) : (
              <Shield className={`w-3.5 h-3.5 ${boundaries.features.length > 0 ? 'text-emerald-400' : 'text-slate-500'}`} />
            )}
            <span>{statusText()}</span>
          </div>
        )}

        {!isOfflineMode && showBoundaries && boundaries.features.length > 0 && (
          <div className="bg-slate-900/90 backdrop-blur-md border border-slate-700/80 rounded-xl px-3 py-2 shadow-xl anim-in-up">
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
                    <span className="text-[10px] text-slate-300 font-semibold">{style.label}</span>
                    <span className="text-[10px] text-slate-500">({source.featureCount})</span>
                  </div>
                );
              })}

            <div className="mt-1.5 pt-1.5 border-t border-slate-700/60 max-w-[210px]">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className="w-3 h-3 rounded-sm shrink-0"
                  style={{ background: 'linear-gradient(90deg, rgba(148,163,184,0.05), rgba(148,163,184,0.45))' }}
                />
                <span className="text-[10px] text-slate-400 font-semibold">Uncertainty band</span>
              </div>
              <p className="text-[9px] text-slate-500 leading-tight">
                Edges are drawn as a fade, not a line, because no source here is
                survey-grade. Inside the fade you may be on either side of the real
                boundary. Not permission to camp.
              </p>
            </div>
          </div>
        )}

        {!isWithinCoverage(center[0], center[1]) && (
          <div className="bg-slate-800/95 backdrop-blur-md border border-slate-600 text-slate-300 px-3 py-1.5 rounded-xl text-xs font-semibold shadow-xl flex items-center gap-2 max-w-[260px] anim-in-up">
            <Eye className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span>Outside coverage. Wandrlust currently supports {COVERAGE_LABEL}.</span>
          </div>
        )}
      </div>

      {/* Layer controls */}
      <div className="absolute top-3 right-3 z-[400] flex flex-col items-end gap-2">
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
