import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.vectorgrid';
import * as turf from '@turf/turf';
import { Campsite, LandType, MapTileLayer } from '../types';
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
import { Layers, Compass, Crosshair, MapPin, Tent, Eye, Shield, Loader2 } from 'lucide-react';

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
  campsites,
  selectedCampsite,
  onSelectCampsite,
  center,
  zoom,
  userLocation,
  isOfflineMode,
  onOpenDetailModal,
  onVisibleCampsitesChange,
  onLocateUser,
  isLocating = false
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersRef = useRef<{ [key: string]: L.Marker }>({});
  const markerClusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const userMarkerRef = useRef<L.Marker | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const [activeTileLayer, setActiveTileLayer] = useState<MapTileLayer>('satellite');
  const [isMapReady, setIsMapReady] = useState<boolean>(false);
  const [showCrownLand, setShowCrownLand] = useState<boolean>(true);
  const [crownLandAvailable, setCrownLandAvailable] = useState<boolean>(false);
  const [showLayerMenu, setShowLayerMenu] = useState<boolean>(false);
  const [showBoundaries, setShowBoundaries] = useState<boolean>(true);
  const [boundaries, setBoundaries] = useState<BoundaryCollection>(EMPTY_BOUNDARIES);
  const [isLoadingBoundaries, setIsLoadingBoundaries] = useState<boolean>(false);
  const [zoomTooFar, setZoomTooFar] = useState<boolean>(false);
  const boundaryLayerRef = useRef<any>(null);
  const coverageMaskRef = useRef<any>(null);

  // Define Tile Layer URLs
  const TILE_URLS: Record<MapTileLayer, { url: string; attribution: string }> = {
    satellite: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles &copy; Esri'
    },
    topo: {
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)'
    },
    street: {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap contributors'
    },
    public_lands: {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap contributors'
    }
  };

  const getLandTypeColor = (type: LandType): string => {
    switch (type) {
      case 'blm': return '#F59E0B';
      case 'usfs': return '#10B981';
      case 'state_forest': return '#8B5CF6';
      case 'crown_land': return '#06B6D4';
      default: return '#8B5CF6';
    }
  };

  const getLandTypeBadgeText = (type: LandType): string => {
    switch (type) {
      case 'blm': return 'BLM';
      case 'usfs': return 'USFS';
      case 'state_forest': return 'STATE';
      case 'crown_land': return 'CROWN';
      default: return 'SPOT';
    }
  };

  // Initialize Leaflet Map
  useEffect(() => {
    if (!mapContainerRef.current) return;
    if (!mapInstanceRef.current) {
      const map = L.map(mapContainerRef.current, {
        center,
        zoom,
        zoomControl: false,
        attributionControl: false
      });

      L.control.zoom({ position: 'bottomright' }).addTo(map);

      const tileConfig = TILE_URLS[activeTileLayer];
      const tileLayer = L.tileLayer(tileConfig.url, {
        maxZoom: 19,
        attribution: tileConfig.attribution
      }).addTo(map);
      
      tileLayerRef.current = tileLayer;
      mapInstanceRef.current = map;
      setIsMapReady(true);

      const timer = setTimeout(() => {
        if (mapInstanceRef.current) {
          try {
            mapInstanceRef.current.invalidateSize();
          } catch (e) {}
        }
      }, 200);

      return () => {
        clearTimeout(timer);
        if (mapInstanceRef.current) {
          try {
            mapInstanceRef.current.remove();
          } catch (e) {}
          mapInstanceRef.current = null;
        }
      };
    }
  }, []);

  // Swap the base raster layer when the style changes, or when the user drops
  // into offline mode (which reads tiles from IndexedDB instead of the network).
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !isMapReady) return;

    const config = TILE_URLS[activeTileLayer];
    if (!config) return;

    if (tileLayerRef.current) {
      try { map.removeLayer(tileLayerRef.current); } catch { /* already removed */ }
    }

    let layer: L.TileLayer;

    if (isOfflineMode) {
      // Serve previously downloaded tiles; render a placeholder on a miss.
      const OfflineTileLayer = (L.TileLayer as any).extend({
        createTile(coords: { z: number; x: number; y: number }, done: Function) {
          const tile = document.createElement('img');
          tile.alt = '';
          getCachedTile(coords.z, coords.x, coords.y)
            .then((objectUrl) => { tile.src = objectUrl ?? TRANSPARENT_PIXEL; done(null, tile); })
            .catch(() => { tile.src = TRANSPARENT_PIXEL; done(null, tile); });
          return tile;
        }
      });
      layer = new OfflineTileLayer('', { maxZoom: 19, attribution: 'Offline tile cache' });
    } else {
      layer = L.tileLayer(config.url, { maxZoom: 19, attribution: config.attribution });
    }

    layer.addTo(map);
    tileLayerRef.current = layer;
  }, [activeTileLayer, isMapReady, isOfflineMode]);

  // Crown Land Vector Grid Layer.
  // Requires your own Mapbox account: set VITE_MAPBOX_TOKEN and
  // VITE_CROWN_LAND_TILESET in .env. When absent the layer is simply skipped.
  useEffect(() => {
    const map = mapInstanceRef.current;
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

    const vectorUrl = `https://a.tiles.mapbox.com/v4/${tileset}/{z}/{x}/{y}.vector.pbf?access_token=${token}`;

    let vectorLayer: L.Layer | null = null;
    try {
      // leaflet.vectorgrid has no bundled types, hence the cast.
      vectorLayer = (L as any).vectorGrid.protobuf(vectorUrl, {
        pane: 'crownLandPane',
        interactive: false,
        vectorTileLayerStyles: {
          [styleLayer]: {
            fill: true, fillColor: '#10B981', fillOpacity: 0.25,
            color: '#059669', weight: 1
          }
        }
      });
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

  // Grey mask over everything outside the supported coverage area.
  // Drawn as a world-sized polygon with the supported region punched out.
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !isMapReady) return;

    if (!map.getPane('coveragePane')) {
      map.createPane('coveragePane');
      const pane = map.getPane('coveragePane');
      if (pane) {
        pane.style.zIndex = '450';
        pane.style.pointerEvents = 'none';
      }
    }

    const toLatLng = (ring: [number, number][]) =>
      ring.map(([lon, lat]) => [lat, lon] as [number, number]);

    const mask = L.polygon([toLatLng(WORLD_RING), toLatLng(COVERAGE_OUTLINE)], {
      pane: 'coveragePane', interactive: false, stroke: true,
      color: '#475569', weight: 1, fillColor: '#0F172A', fillOpacity: 0.72
    }).addTo(map);

    coverageMaskRef.current = mask;
    return () => { try { map.removeLayer(mask); } catch { /* detached */ } };
  }, [isMapReady]);

  // Fetch and draw authoritative public-land boundaries for the viewport.
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !isMapReady) return;

    if (!showBoundaries || isOfflineMode) {
      if (boundaryLayerRef.current) {
        try { map.removeLayer(boundaryLayerRef.current); } catch { /* detached */ }
        boundaryLayerRef.current = null;
      }
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
          if (boundaryLayerRef.current) {
            try { map.removeLayer(boundaryLayerRef.current); } catch { /* noop */ }
            boundaryLayerRef.current = null;
          }
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

        if (boundaryLayerRef.current) {
          try { map.removeLayer(boundaryLayerRef.current); } catch { /* noop */ }
          boundaryLayerRef.current = null;
        }
        if (collection.features.length === 0) return;

        if (!map.getPane('boundariesPane')) {
          map.createPane('boundariesPane');
          const pane = map.getPane('boundariesPane');
          if (pane) pane.style.zIndex = '390';
        }

        // ---- Fuzzy edge rendering -------------------------------------
        // We never draw a crisp boundary line. Each polygon gets a soft fill
        // plus a stack of translucent strokes whose total width equals the
        // dataset's real positional uncertainty, converted from metres to
        // pixels at the current zoom. A hard line would claim a precision
        // none of these sources have, and the failure mode is somebody
        // parking on private land.
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
          onEachFeature: (feature: any, lyr: any) => {
            const p = feature?.properties ?? {};
            const style = BOUNDARY_STYLES[p._confidence as BoundaryConfidence];
            const edgeNote = p._edgeAccuracy
              ? EDGE_ACCURACY_COPY[p._edgeAccuracy as EdgeAccuracy]
              : 'Boundary accuracy unknown.';
            const basisNote = p._campingBasisKind
              ? CAMPING_BASIS_COPY[p._campingBasisKind as CampingBasisKind]
              : 'Camping basis unknown.';

            lyr.bindPopup(
              `<div style="font-family:system-ui;font-size:12px;min-width:230px;max-width:300px">
                 <strong style="font-size:13px">${p._name ?? 'Public land'}</strong><br/>
                 <span style="color:#334155">${p._designation ?? ''}</span><br/>
                 <span style="display:inline-block;margin-top:6px;padding:2px 6px;border-radius:6px;background:${
                   style?.fillColor ?? '#94A3B8'
                 };color:#0F172A;font-weight:700;font-size:10px">${style?.label ?? 'Public land'}</span>
                 <div style="margin-top:8px;padding-top:6px;border-top:1px solid #E2E8F0">
                   <div style="color:#475569;font-size:10px;margin-bottom:4px"><strong>Edges:</strong> ${edgeNote}</div>
                   <div style="color:#475569;font-size:10px;margin-bottom:4px"><strong>Camping:</strong> ${basisNote}</div>
                 </div>
                 <span style="color:#64748B;font-size:10px;display:block;margin-top:6px">Source: ${p._attribution ?? 'Unknown'}</span>
                 <div style="margin-top:8px;padding:6px;border-radius:6px;background:#FEF3C7;border:1px solid #FCD34D">
                   <div style="color:#92400E;font-size:10px;font-weight:700;margin-bottom:2px">Boundary uncertainty: ${
                     p._edgeAccuracy ? UNCERTAINTY_LABEL[p._edgeAccuracy as EdgeAccuracy] : 'unknown'
                   }</div>
                   <div style="color:#92400E;font-size:10px;line-height:1.35">${
                     p._edgeAccuracy ? uncertaintyCaution(p._edgeAccuracy as EdgeAccuracy)
                     : 'Edge accuracy is unknown for this source. Treat the boundary as approximate.'
                   }</div>
                 </div>
                 <span style="color:#B45309;font-size:10px;display:block;margin-top:6px;font-weight:600">Not survey-grade, and not a legal boundary. Only a licensed survey establishes property lines.</span>
               </div>`
            );
          }
        });

        // Build the feathered uncertainty band: one translucent stroke per
        // ring, stacked widest-first so the edge fades outward into nothing.
        collection.features.forEach((feature: any) => {
          const accuracy: EdgeAccuracy = feature?.properties?._edgeAccuracy ?? 'administrative';
          if (shouldSimplify(accuracy, centreLat, currentZoom)) return;

          const confidence: BoundaryConfidence = feature?.properties?._confidence ?? 'managing_agency';
          const style = BOUNDARY_STYLES[confidence] ?? BOUNDARY_STYLES.managing_agency;
          const rings = buildFuzzRings(accuracy, centreLat, currentZoom);

          rings.forEach((ring) => {
            const halo = L.geoJSON(feature, {
              pane: 'boundariesPane',
              interactive: false,
              style: {
                color: style.color, weight: ring.weight, opacity: ring.opacity,
                fill: false, lineJoin: 'round', lineCap: 'round'
              }
            });
            haloGroup.addLayer(halo);
          });
        });

        haloGroup.addTo(map);
        layer.addTo(map);

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

  // Report which campsites fall inside the current viewport.
  useEffect(() => {
    const map = mapInstanceRef.current;
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

  // Handle markers and clustering
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !isMapReady) return;

    if (markerClusterRef.current) {
      map.removeLayer(markerClusterRef.current);
    }

    const clusterGroup = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 40,
      iconCreateFunction: (cluster) => {
        const count = cluster.getChildCount();
        return L.divIcon({
          html: `<div class="w-8 h-8 rounded-full bg-slate-900 border-2 border-emerald-400 flex items-center justify-center text-white font-bold text-xs shadow-xl">${count}</div>`,
          className: 'custom-cluster-icon',
          iconSize: [32, 32],
          iconAnchor: [16, 16]
        });
      }
    });

    campsites.forEach((site) => {
      const isSelected = selectedCampsite?.id === site.id;
      const hexColor = getLandTypeColor(site.landType);
      const badge = getLandTypeBadgeText(site.landType);

      const customIcon = L.divIcon({
        className: 'custom-campsite-marker',
        html: `
          <div class="relative flex items-center justify-center transition-all duration-300 ${
            isSelected ? 'scale-125 z-50' : 'hover:scale-110 z-10'
          }">
            <div class="w-8 h-8 rounded-full flex items-center justify-center shadow-xl border-2 ${
              isSelected ? 'border-white ring-4 ring-emerald-400/50' : 'border-slate-900'
            }" style="background-color: ${hexColor}">
              <svg class="w-4 h-4 text-slate-950 stroke-[2.5]" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path d="M19 20 12 4 5 20" />
                <path d="M12 4v16" />
                <path d="M2 20h20" />
              </svg>
            </div>
            <div class="absolute -top-2 -right-2 px-1 py-0.2 text-[9px] font-black tracking-tighter text-white bg-slate-950 rounded-full border border-slate-700 shadow">
              ${badge}
            </div>
          </div>
        `,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
      });

      try {
        const marker = L.marker([site.latitude, site.longitude], { icon: customIcon });
        marker.on('click', () => {
          onSelectCampsite(site);
        });
        clusterGroup.addLayer(marker);
        markersRef.current[site.id] = marker;
      } catch (e) {}
    });

    map.addLayer(clusterGroup);
    markerClusterRef.current = clusterGroup;

  }, [campsites, selectedCampsite, isMapReady]);

  // Handle user location marker
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !isMapReady) return;

    if (userLocation) {
      if (userMarkerRef.current) {
        try {
          userMarkerRef.current.remove();
        } catch (e) {}
      }
      
      const userIcon = L.divIcon({
        className: 'user-location-marker',
        html: `
          <div class="relative flex items-center justify-center">
            <div class="absolute w-12 h-12 bg-blue-500/20 rounded-full animate-ping"></div>
            <div class="w-4 h-4 bg-blue-500 border-2 border-white rounded-full shadow-lg relative z-10"></div>
          </div>
        `,
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });

      userMarkerRef.current = L.marker(userLocation, { icon: userIcon }).addTo(map);
    }
  }, [userLocation, isMapReady]);

  // Handle center flyTo
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (map && isMapReady) {
      try {
        map.flyTo(center, zoom, { duration: 1.2 });
      } catch (e) {
        try { map.setView(center, zoom); } catch(err) {}
      }
    }
  }, [center, zoom, isMapReady]);

  return (
    <div className="relative w-full h-full min-h-[400px] bg-slate-950 overflow-hidden" ref={mapContainerRef}>
      {/* Real Boundary GIS Status Banner */}
      <div className="absolute top-3 left-3 z-[400] flex flex-col gap-1">
        {isOfflineMode ? (
          <div className="bg-amber-500 text-slate-950 px-3 py-1.5 rounded-xl font-bold text-xs shadow-xl flex items-center gap-2 border border-amber-300">
            <span className="w-2 h-2 rounded-full bg-slate-950 animate-ping" />
            Offline Mode Active - Rendering Local Map Cache & Saved Spots
          </div>
        ) : (
          <div className="bg-slate-900/90 backdrop-blur-md text-slate-200 px-3 py-1.5 rounded-xl text-xs font-semibold shadow-xl flex items-center gap-2 border border-slate-700/80 anim-in-down">
            {isLoadingBoundaries ? (
              <Loader2 className="w-3.5 h-3.5 text-emerald-400 animate-spin" />
            ) : (
              <Shield className={`w-3.5 h-3.5 ${boundaries.features.length > 0 ? 'text-emerald-400' : 'text-slate-500'}`} />
            )}
            <span>
              {!showBoundaries ? 'Land boundaries hidden'
                : zoomTooFar ? 'Zoom in to load land boundaries'
                : isLoadingBoundaries ? 'Loading public land boundaries…'
                : boundaries.features.length > 0 ? `${boundaries.features.length} land parcels in view`
                : 'No mapped public land in view'}
            </span>
          </div>
        )}

        {/* Legend — only what is actually on screen right now. */}
        {!isOfflineMode && showBoundaries && boundaries.features.length > 0 && (
          <div className="bg-slate-900/90 backdrop-blur-md border border-slate-700/80 rounded-xl px-3 py-2 shadow-xl anim-in-up">
            {boundaries.meta.sources.filter((source) => source.featureCount > 0).map((source) => {
              const style = BOUNDARY_STYLES[source.confidence];
              return (
                <div key={source.id} className="flex items-center gap-2 py-0.5">
                  <span className="w-3 h-3 rounded-sm border shrink-0"
                    style={{ backgroundColor: style.fillColor, borderColor: style.color }} />
                  <span className="text-[10px] text-slate-300 font-semibold">{style.label}</span>
                  <span className="text-[10px] text-slate-500">({source.featureCount})</span>
                </div>
              );
            })}
            <div className="mt-1.5 pt-1.5 border-t border-slate-700/60 max-w-[210px]">
              <div className="flex items-center gap-2 mb-1">
                <span className="w-3 h-3 rounded-sm shrink-0"
                  style={{ background: 'linear-gradient(90deg, rgba(148,163,184,0.05), rgba(148,163,184,0.45))' }} />
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

        {/* Out-of-coverage notice */}
        {!isWithinCoverage(center[0], center[1]) && (
          <div className="bg-slate-800/95 backdrop-blur-md border border-slate-600 text-slate-300 px-3 py-1.5 rounded-xl text-xs font-semibold shadow-xl flex items-center gap-2 max-w-[260px] anim-in-up">
            <Eye className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span>Outside coverage. Wandrlust currently supports {COVERAGE_LABEL}.</span>
          </div>
        )}
      </div>

      {/* Base layer switcher & overlay toggles */}
      <div className="absolute top-3 right-3 z-[400] flex flex-col items-end gap-2">
        <button
          type="button"
          onClick={() => setShowLayerMenu((open) => !open)}
          className="p-2 rounded-xl bg-slate-900/90 backdrop-blur-md border border-slate-700/80 text-slate-200 hover:text-white shadow-xl"
          title="Map layers"
          aria-label="Map layers"
        >
          <Layers className="w-4 h-4" />
        </button>

        {showLayerMenu && (
          <div className="bg-slate-900/95 backdrop-blur-md border border-slate-700/80 rounded-xl p-2 shadow-2xl w-48 anim-in-down">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold px-1 pb-1">Base map</p>
            {([
              { id: 'satellite', label: 'Satellite' },
              { id: 'topo', label: 'Topographic' },
              { id: 'street', label: 'Street' }
            ] as { id: MapTileLayer; label: string }[]).map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setActiveTileLayer(option.id)}
                className={`w-full text-left px-2 py-1.5 rounded-lg text-xs font-semibold ${
                  activeTileLayer === option.id ? 'bg-emerald-600 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                {option.label}
              </button>
            ))}

            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold px-1 pt-2 pb-1">Overlays</p>
            <label className="flex items-center justify-between px-2 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
              <span>Public land boundaries</span>
              <input type="checkbox" checked={showBoundaries}
                onChange={(e) => setShowBoundaries(e.target.checked)}
                className="accent-emerald-500 w-3.5 h-3.5" />
            </label>
            <label className="flex items-center justify-between px-2 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
              <span>
                Crown land tiles
                {!crownLandAvailable && (
                  <span className="block text-[9px] text-slate-500">needs Mapbox token</span>
                )}
              </span>
              <input type="checkbox" checked={showCrownLand}
                onChange={(e) => setShowCrownLand(e.target.checked)}
                className="accent-emerald-500 w-3.5 h-3.5" />
            </label>
          </div>
        )}

        {onLocateUser && (
          <button
            type="button"
            onClick={onLocateUser}
            disabled={isLocating}
            className="p-2 rounded-xl bg-slate-900/90 backdrop-blur-md border border-slate-700/80 text-slate-200 hover:text-white shadow-xl disabled:opacity-50"
            title="Centre on my location"
            aria-label="Centre on my location"
          >
            {isLocating ? <Loader2 className="w-4 h-4 animate-spin text-emerald-400" /> : <Crosshair className="w-4 h-4" />}
          </button>
        )}
      </div>

      {/* Selected Campsite Preview Card */}
      {selectedCampsite && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[90%] max-w-sm z-[999] animate-in slide-in-from-bottom-8 fade-in duration-300">
          <div className="bg-slate-900/95 backdrop-blur-md border border-slate-700/60 p-3 rounded-2xl shadow-2xl flex flex-col">
            <div className="flex justify-between items-start mb-2">
              <div className="flex flex-col">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: getLandTypeColor(selectedCampsite.landType) }} />
                  <span className="text-[11px] font-bold text-slate-300 tracking-wider">
                    {getLandTypeBadgeText(selectedCampsite.landType)}
                  </span>
                  <span className="text-slate-600">•</span>
                  <span className="text-[11px] text-slate-400 font-medium">
                    {selectedCampsite.address.nearestCity}, {selectedCampsite.address.stateProvince}
                  </span>
                </div>
                <h3 className="font-['Outfit'] font-bold text-base text-slate-100 line-clamp-1">
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
              <div className="flex items-center gap-2">
                <span>⭐️ {selectedCampsite.rating} ({selectedCampsite.reviewCount})</span>
                <span>•</span>
                <span className="text-emerald-400 font-semibold">Public Land</span>
              </div>
              <div className="text-[11px] text-slate-400">
                {selectedCampsite.amenities.stayLimitDays}d max stay
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};


