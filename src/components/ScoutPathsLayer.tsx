import React, { useEffect, useRef, useMemo } from 'react';
import L from 'leaflet';
import type { ScoutRoadSegment, ViewportBounds } from '../services/roadSegmentService';
import { SCOUT_SURFACE_COLOR, SCOUT_SURFACE_LABEL, SCOUT_PATHS_MIN_ZOOM, fetchScoutRoadSegments } from '../services/roadSegmentService';

/**
 * Surface type to Leaflet path options mapping.
 * Uses different stroke styles (dash patterns) to represent different road surfaces.
 */
const SURFACE_STYLES: Record<string, L.PathOptions> = {
  smooth_paved: {
    color: SCOUT_SURFACE_COLOR.smooth_paved,
    weight: 3,
    opacity: 0.9,
    lineCap: 'round',
    lineJoin: 'round',
    dashArray: null,
  },
  rough_paved: {
    color: SCOUT_SURFACE_COLOR.rough_paved,
    weight: 3,
    opacity: 0.9,
    lineCap: 'round',
    lineJoin: 'round',
    dashArray: '5,3',
  },
  good_gravel: {
    color: SCOUT_SURFACE_COLOR.good_gravel,
    weight: 3,
    opacity: 0.9,
    lineCap: 'round',
    lineJoin: 'round',
    dashArray: '3,2,1,2',
  },
  washboard: {
    color: SCOUT_SURFACE_COLOR.washboard,
    weight: 4,
    opacity: 0.9,
    lineCap: 'round',
    lineJoin: 'round',
    dashArray: '8,4,2,4',
  },
  rutted_dirt: {
    color: SCOUT_SURFACE_COLOR.rutted_dirt,
    weight: 2,
    opacity: 0.9,
    lineCap: 'round',
    lineJoin: 'round',
    dashArray: '10,5',
  },
  rock_crawl: {
    color: SCOUT_SURFACE_COLOR.rock_crawl,
    weight: 5,
    opacity: 0.9,
    lineCap: 'round',
    lineJoin: 'round',
    dashArray: '15,10',
  },
  impassable: {
    color: SCOUT_SURFACE_COLOR.impassable,
    weight: 1,
    opacity: 0.9,
    lineCap: 'round',
    lineJoin: 'round',
    dashArray: '2,2',
  },
};

const getOpacityForSampleCount = (sampleCount: number): number => {
  if (sampleCount >= 10) return 0.9;
  if (sampleCount >= 5) return 0.7;
  if (sampleCount >= 3) return 0.5;
  return 0.3;
};

interface ScoutPathsLayerProps {
  bounds: ViewportBounds;
  zoom: number;
  visible: boolean;
}

export const ScoutPathsLayer: React.FC<ScoutPathsLayerProps> = ({ bounds, zoom, visible }) => {
  const layerRef = useRef<L.GeoJSON | null>(null);
  const dataRef = useRef<ScoutRoadSegment[]>([]);
  
  const shouldShow = visible && zoom >= SCOUT_PATHS_MIN_ZOOM;
  
  useEffect(() => {
    if (!shouldShow) {
      if (layerRef.current) {
        layerRef.current.clearLayers();
      }
      return;
    }
    
    const abortController = new AbortController();
    
    fetchScoutRoadSegments(bounds, abortController.signal)
      .then((scan) => {
        if (abortController.signal.aborted) return;
        
        dataRef.current = scan.segments;
        
        if (layerRef.current) {
          layerRef.current.clearLayers();
          if (scan.segments.length > 0) {
            const geoJson = segmentsToGeoJSON(scan.segments);
            layerRef.current.addData(geoJson);
          }
        }
      })
      .catch(() => {});
    
    return () => {
      abortController.abort();
    };
  }, [shouldShow, bounds.minLat, bounds.minLon, bounds.maxLat, bounds.maxLon, zoom]);
  
  const segmentsToGeoJSON = (segments: ScoutRoadSegment[]): GeoJSON.FeatureCollection => ({
    type: 'FeatureCollection',
    features: segments.map((segment) => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: segment.line.map(([lon, lat]) => [lon, lat] as [number, number]),
      },
      properties: {
        id: segment.id,
        surface: segment.surface,
        roughness: segment.roughness,
        sampleCount: segment.sampleCount,
        updatedAt: segment.updatedAt,
        label: SCOUT_SURFACE_LABEL[segment.surface] || segment.surface,
      },
    })),
  });
  
  const styleFunction = (feature: GeoJSON.Feature | undefined): L.PathOptions => {
    if (!feature || !feature.properties) {
      return { color: '#666', weight: 2, opacity: 0.5 };
    }
    
    const surface = (feature.properties as any).surface as string;
    const sampleCount = (feature.properties as any).sampleCount as number;
    const baseStyle = SURFACE_STYLES[surface] || SURFACE_STYLES.smooth_paved;
    
    return {
      ...baseStyle,
      opacity: getOpacityForSampleCount(sampleCount),
    };
  };
  
  const onEachFeature = (feature: GeoJSON.Feature, layer: L.Layer): void => {
    if (!feature.properties) return;
    
    const props = feature.properties as any;
    const label = props.label || props.surface || 'Unknown surface';
    const sampleCount = props.sampleCount || 0;
    const roughness = props.roughness || 0;
    
    const tooltipContent = `
      <div style="min-width: 120px;">
        <strong style="color: ${SCOUT_SURFACE_COLOR[props.surface] || '#666'};">${label}</strong>
        <br/>
        <small>Samples: ${sampleCount}</small>
        <br/>
        <small>Roughness: ${Math.round(roughness)}%</small>
      </div>
    `;
    
    if (layer.bindTooltip) {
      layer.bindTooltip(tooltipContent, {
        permanent: false,
        direction: 'top',
        className: 'scout-path-tooltip',
      });
    }
  };
  
  useEffect(() => {
    if (!shouldShow) return;
    
    const map = (window as any).leafletMap;
    if (!map) return;
    
    layerRef.current = L.geoJSON(undefined as any, {
      style: styleFunction,
      onEachFeature,
      renderer: new L.SVG({ padding: 0.5 }),
    });
    
    layerRef.current.addTo(map);
    
    fetchScoutRoadSegments(bounds)
      .then((scan) => {
        if (scan.segments.length > 0) {
          const geoJson = segmentsToGeoJSON(scan.segments);
          layerRef.current?.addData(geoJson);
        }
      });
    
    return () => {
      if (layerRef.current) {
        const map = (window as any).leafletMap;
        if (map) {
          map.removeLayer(layerRef.current);
        }
        layerRef.current = null;
      }
    };
  }, [shouldShow]);
  
  useEffect(() => {
    if (!shouldShow || !layerRef.current) return;
  }, [zoom, shouldShow]);
  
  return null;
};

export default ScoutPathsLayer;