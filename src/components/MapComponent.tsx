import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.vectorgrid';
import {
  AlertTriangle, ChevronDown, Crosshair, Eye, Info, Layers, Loader2,
  MousePointerClick, Shield
} from 'lucide-react';

import type {
  Campsite, DestinationLand, MapDestination, MapTileLayer
} from '../types';
import { getCachedTile } from '../services/offlineStorage';
import { pointInGeometry } from '../utils/geo';
import { hazardReportStyle, reportStanding } from '../config/hazardReports';
import { fetchHazardsNear, HazardRecord } from '../services/dataService';
import {
  fetchBoundaries, requestBoxFor, overviewBoxFor, boxContains, BOUNDARY_STYLES,
  EMPTY_BOUNDARIES, BoundaryCollection, BoundaryConfidence, BoundaryFeature,
  BoundaryDetail, EdgeAccuracy
} from '../services/boundaryService';
import {
  buildFuzzRings, ringBudget, edgeBlurPx, UNCERTAINTY_LABEL, shouldSimplify
} from '../utils/fuzzyBoundary';
import {
  AlertBadge, BADGE_LABEL, BADGE_COLOR, badgesForPoint, alertBadge,
  hazardCloudHtml, preciseMarkerHtml, isDiffuse, warningGlyphPattern,
  WARNING_EMOJI, WARNING_LABEL,
  dissolveKey, dissolveSegments, dissolvedFill
} from '../utils/alertOverlay';
import {
  BoundingBox, COVERAGE_OUTLINE, WORLD_RING, BOUNDARY_MIN_ZOOM,
  BOUNDARY_OVERVIEW_MIN_ZOOM, overviewMinAreaSqKm,
  COVERAGE_LABEL, isWithinCoverage
} from '../config/coverage';
import {
  fetchAreaAlerts, HazardAlert, HAZARD_STYLE, sortAlerts
} from '../services/weatherService';
import { prefersReducedMotion } from '../utils/animation';

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
const buildCampsiteIcon = (isSelected: boolean, badges: AlertBadge[] = []): L.DivIcon => {
  // A small word-chip per active alert, stacked just above the pin. Fire, Flood,
  // Smoke — the same words a camper reads in the alert panel, in the family
  // colour, so the map says what's wrong here without opening anything.
  const chips = badges
    .map(
      (b) =>
        `<span style="background:${BADGE_COLOR[b]};color:#0b1120;font-size:9px;` +
        `font-weight:800;line-height:1;padding:2px 5px;border-radius:5px;` +
        `border:1px solid rgba(2,6,23,.55);white-space:nowrap;` +
        `box-shadow:0 1px 3px rgba(0,0,0,.45)">${BADGE_LABEL[b]}</span>`
    )
    .join('');
  const chipStack = badges.length
    ? `<div style="position:absolute;bottom:100%;left:50%;transform:translateX(-50%);` +
      `margin-bottom:3px;display:flex;flex-direction:column;gap:2px;align-items:center;` +
      `pointer-events:none">${chips}</div>`
    : '';
  return L.divIcon({
    className: 'custom-campsite-marker',
    html: `
      <div class="relative flex items-center justify-center ${isSelected ? 'scale-125 z-50' : 'z-10'}">
        ${chipStack}
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
};

/**
 * A camper's hazard report.
 *
 * Now the SAME animated cloud as an official warning, by request — coloured by
 * the hazard, carrying its icon, with a slow drifting strand keyed to the kind
 * (rising smoke for fire, sliding water for a washout, sharp cold for a snow
 * drift). A confirmed report gets a pale ring around the cloud.
 *
 * The look matches; the behaviour does not, and that is where the honesty
 * lives. This marker stays interactive — tapping it opens the card that spells
 * out it is one camper's report, not verified — whereas an official warning is
 * drawn in a pointer-events:none pane and cannot be tapped at all.
 */
const buildHazardReportIcon = (record: HazardRecord): L.DivIcon => {
  const style = hazardReportStyle(record.kind);
  const confirmed = reportStanding(record.confirms, record.disputes) === 'confirmed';
  // Smaller than an official warning cloud: a report is a point on a road, not
  // a region, so it should not shout over the area overlays.
  const size = style.prominent ? 56 : 46;
  const height = Math.round((size * 64) / 72);

  return L.divIcon({
    className: 'hazard-report-marker',
    html: hazardCloudHtml({
      color: style.color,
      motion: style.motion,
      reduced: prefersReducedMotion(),
      size,
      glyph: style.emoji,
      outline: confirmed
    }),
    iconSize: [size, height],
    // Anchor on the cloud body (~y 30/64) so it sits on the reported point.
    iconAnchor: [size / 2, Math.round((size * 30) / 72)]
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

/** A geometry's bounding box as [minLon, minLat, maxLon, maxLat], or null. */
const geometryBbox = (
  geometry: unknown
): [number, number, number, number] | null => {
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
  if (minLon === Infinity) return null;
  return [minLon, minLat, maxLon, maxLat];
};

/**
 * The NARROWEST side of a feature's bounding box, in screen pixels at the
 * current view. This is what tells a razor-thin sliver apart from a real
 * parcel: a sliver is long but only a pixel or two wide, so its narrow side is
 * tiny however big its area or its long side is. A genuine parcel is wide on
 * both axes. Used to drop slivers before they draw, so leftover hairline
 * splinters from the source data simply never appear.
 */
const featureMinDimPx = (map: L.Map, geometry: unknown): number => {
  const box = geometryBbox(geometry);
  if (!box) return Number.MAX_SAFE_INTEGER;
  const [minLon, minLat, maxLon, maxLat] = box;
  const a = map.latLngToLayerPoint([minLat, minLon]);
  const b = map.latLngToLayerPoint([maxLat, maxLon]);
  return Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
};

/**
 * Read an SVG path's `d` attribute back into a list of [lon, lat] points.
 *
 * For the cloud's radial gradient we need a centroid per ring, and the
 * ring is owned by an SVG <path> rendered by Leaflet's geoJSON layer.
 * We don't have a back-reference to the source geometry from the path,
 * so we walk the `d` attribute and pull out every coordinate pair. This
 * skips arcs (we only care about point locations for the centroid) —
 * the resulting list is good enough for a mean-and-bbox.
 *
 * Returns null if the path's `d` is missing or unparseable. Callers
 * must handle that — a missing centroid means no gradient for that ring,
 * which is fine, the polygon's solid fill still draws.
 */
const readRingFromPath = (path: SVGPathElement): [number, number][] | null => {
  const d = path.getAttribute('d');
  if (!d) return null;
  const out: [number, number][] = [];
  // Match all coordinate pairs in the `d` attribute. Each pair is
  // either "x y" or "x,y" depending on the serializer; the regex
  // tolerates both. We don't care which sub-path or which command —
  // any point on the path is a valid input to a centroid.
  const re = /(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    const lon = Number(m[1]);
    const lat = Number(m[2]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) out.push([lon, lat]);
  }
  return out.length > 0 ? out : null;
};

/**
 * Centroid (mean of vertices) and radius (half the smaller bbox
 * dimension, in degrees) for a ring of [lon, lat] points.
 *
 * The radius is the input to a userSpaceOnUse radialGradient, so it
 * needs to be in the same units as the coordinates (degrees). Half the
 * smaller bbox dimension gives a circle that fits inside the polygon's
 * bbox, which means the gradient's 0%-opacity stop lands at or just
 * inside the polygon's edge — the cloud fades to nothing right at the
 * polygon's boundary, not before it and not well after.
 */
const centroidAndRadius = (ring: [number, number][]): { cx: number; cy: number; r: number } => {
  let sumLon = 0;
  let sumLat = 0;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    sumLon += lon;
    sumLat += lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const n = ring.length;
  return {
    cx: sumLon / n,
    cy: sumLat / n,
    // Pad the radius slightly (1.05x) so the 100% transparent stop lands
    // just outside the polygon's actual edge — the polygon outline is
    // hidden under the 0-opacity tail, and the visible cloud extends
    // right to the polygon boundary without a hard ring.
    r: 1.05 * Math.min(maxLon - minLon, maxLat - minLat) / 2
  };
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
/**
 * An alert marker that says what KIND of alert it is at a glance.
 *
 * Every one of these used to be the same grey exclamation triangle, so a map
 * with a fire ban, a flood watch and a snowfall warning on it looked like
 * three copies of one anonymous hazard. The family's own colour and symbol now
 * carry the meaning: you should be able to tell fire from flood without
 * opening anything.
 *
 * Shape follows severity rather than adding a second colour language — a
 * severe or extreme alert gets the pointed triangle and a pulse, everything
 * milder gets a calmer rounded badge. That keeps the loud treatment for things
 * that have actually been called dangerous.
 */
const buildHazardIcon = (alert: HazardAlert): L.DivIcon => {
  const style = HAZARD_STYLE[alert.family] ?? HAZARD_STYLE.other;
  const urgent = alert.severity === 'extreme' || alert.severity === 'severe';
  const size = urgent ? 34 : 28;

  const shape = urgent
    ? `<path d="M12 2.5 22.5 21H1.5Z" fill="${style.color}" stroke="#0F172A"
             stroke-width="1.6" stroke-linejoin="round"/>`
    : `<rect x="2" y="4" width="20" height="16" rx="5" fill="${style.color}"
             stroke="#0F172A" stroke-width="1.5"/>`;

  return L.divIcon({
    className: 'hazard-alert-marker',
    html: `
      <div class="relative flex items-center justify-center${urgent ? ' anim-pulse-danger' : ''}"
           style="width:${size}px;height:${size}px">
        <svg viewBox="0 0 24 24" class="absolute inset-0 w-full h-full drop-shadow-lg"
             aria-hidden="true">${shape}</svg>
        <span class="relative" style="font-size:${
          urgent ? size * 0.38 : size * 0.44
        }px;line-height:1;${urgent ? 'padding-top:' + size * 0.16 + 'px' : ''}">${style.icon}</span>
      </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, urgent ? size * 0.78 : size / 2]
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
  /**
   * How much of the screen a panel over the map is covering, 0–1.
   *
   * Drives where the destination pin is parked — see the effect that reads it.
   * Zero when nothing is over the map.
   */
  bottomCoverFraction?: number;
  /** Fired when the user taps bare map. Carries the land under the tap. */
  onDropDestination: (lat: number, lon: number, land?: DestinationLand) => void;
  /** Fired when a camper's hazard report is tapped. */
  onSelectHazardReport?: (record: HazardRecord) => void;
  /** Fired when a precise official warning (fire / flood / storm) is tapped. */
  onSelectAlert?: (alert: HazardAlert) => void;
}

export const MapComponent: React.FC<MapComponentProps> = ({
  campsites, selectedCampsite, onSelectCampsite, center, zoom, userLocation,
  isOfflineMode, onOpenDetailModal, onLocateUser,
  isLocating = false,
  destination, onDropDestination, onSelectHazardReport, onSelectAlert,
  bottomCoverFraction = 0
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const userMarkerRef = useRef<L.Marker | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const underlayLayerRef = useRef<L.TileLayer | null>(null);
  const boundaryLayerRef = useRef<L.LayerGroup | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  /** Alert badges affecting each pinned campsite, keyed by id. */
  const badgesByIdRef = useRef<Map<string, AlertBadge[]>>(new Map());

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
  const warningRendererRef = useRef<L.Renderer | null>(null);
  const warningGlyphRendererRef = useRef<L.Renderer | null>(null);
  const destinationMarkerRef = useRef<L.Marker | null>(null);
  /**
   * The one-shot tracer drawn when the user taps a warning chip row. Held
   * by ref so the animation handler can clear it without re-running any
   * effect; the layer itself is the only piece of Leaflet state the
   * animation owns.
   */
  const tracerRef = useRef<L.Layer | null>(null);

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
  const alertTapRef = useRef(onSelectAlert);
  alertTapRef.current = onSelectAlert;

  const [activeTileLayer, setActiveTileLayer] = useState<MapTileLayer>('satellite');
  const [isMapReady, setIsMapReady] = useState(false);
  const [showCrownLand, setShowCrownLand] = useState(true);
  const [crownLandAvailable, setCrownLandAvailable] = useState(false);
  const [showLayerMenu, setShowLayerMenu] = useState(false);
  // Collapsed by default: the map matters more than the key to it.
  const [showLegend, setShowLegend] = useState(false);
  /** Tile credits, off the map until asked for. See the button that sets it. */
  const [showCredits, setShowCredits] = useState(false);
  const [showBoundaries, setShowBoundaries] = useState(true);
  const [boundaries, setBoundaries] = useState<BoundaryCollection>(EMPTY_BOUNDARIES);
  const [isLoadingBoundaries, setIsLoadingBoundaries] = useState(false);
  const [zoomTooFar, setZoomTooFar] = useState(false);
  /** True while the map is showing the large-parcels-only overview. */
  const [isOverviewTier, setIsOverviewTier] = useState(false);
  const [hazards, setHazards] = useState<HazardAlert[]>([]);
  const [unmappableHazards, setUnmappableHazards] = useState(0);
  /** Which warning families are drawn in view — drives the top-left legend. */
  const [warningBadges, setWarningBadges] = useState<AlertBadge[]>([]);
  /**
   * The badge whose tracer is currently animating. Set when the user taps a
   * chip row in the warnings legend; cleared when the tracer finishes (or
   * when a new fetch changes the warnings, whichever comes first). Lives in
   * state rather than a ref because the legend needs to re-render to show
   * which row is "active" while its tracer is running.
   */
  const [tracingBadge, setTracingBadge] = useState<AlertBadge | null>(null);
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
    // Below this many pixels on its short side, a parcel is a razor-thin sliver
    // and is not drawn at all. Slightly higher in the overview, where nothing
    // that small is legible anyway.
    const SLIVER_PX = 2.5;

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
      minDim: (g: unknown) => number
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
        const confidence: BoundaryConfidence = feature?.properties?._confidence ?? 'managing_agency';
        const style = BOUNDARY_STYLES[confidence] ?? BOUNDARY_STYLES.managing_agency;
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
        // ~100 m snap: merges same-type parcels split only by a small
        // vertex mismatch (rasterised vector tiles are routinely off by
        // 30-80 m at shared edges), so adjacent Crown/BLM/PLUZ land of
        // one designation reads as a single shape. Tighter than 100m and
        // the doubled outline shows up where two parcels' shared edge
        // doesn't quite align; looser than 200m and parcels with a real
        // gap of that size start to merge by accident.
        const segments = dissolveSegments(features, 1e-3);
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
      const minDimCache = new Map<unknown, number>();
      const minDim = (g: unknown): number => {
        const cached = minDimCache.get(g);
        if (cached !== undefined) return cached;
        const v = featureMinDimPx(map, g);
        minDimCache.set(g, v);
        return v;
      };
      const sliverCutoff = overview ? 3 : SLIVER_PX;

      /* -- Zoom-only change: rebuild the halo, keep the parcels ---------- */
      if (sameData && fillLayerRef.current && boundaryLayerRef.current && !overview) {
        const group = boundaryLayerRef.current;
        if (haloLayerRef.current) {
          try { group.removeLayer(haloLayerRef.current); } catch { /* gone */ }
        }
        const { group: halo, widest } = buildHalo(collection, centreLat, currentZoom, minDim);
        haloLayerRef.current = halo;
        group.addLayer(halo);
        fillLayerRef.current.setStyle((f: any) => parcelStyle(f, centreLat, currentZoom, false));
        if (pane) pane.style.filter = widest > 0 ? `blur(${edgeBlurPx(widest).toFixed(1)}px)` : '';
        renderSignatureRef.current = signature;
        renderedCollectionRef.current = collection;
        return;
      }

      /* -- New data: full rebuild --------------------------------------- */
      const renderer = boundaryRenderer();

      // No uncertainty band in the overview. At zoom 4 a ±200 m band is a
      // fraction of a pixel, so it would draw as a slightly thicker line that
      // says nothing — while costing one extra pass over every polygon.
      const halo = overview ? null : buildHalo(collection, centreLat, currentZoom, minDim);

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
      const dissolved = dissolvedFill(
        collection.features as { properties?: Record<string, any>; geometry: unknown }[],
        dissolveKey,
        1e-3
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
          style: (feature: any) => parcelStyle(feature, centreLat, currentZoom, overview)
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

  /**
   * Park the pin in the map you can still see.
   *
   * ---------------------------------------------------------------------
   * THE BUG THIS FIXES
   * ---------------------------------------------------------------------
   *
   * You tapped a spot, the detail panel slid up over the bottom half of the
   * screen, and the panel covered the thing you had just tapped. Opening the
   * panel further to read it buried the pin completely. The app's answer to
   * "what is here?" was to hide "here".
   *
   * So the pin is not centred in the WINDOW, it is centred in what is left of
   * the map: the strip between the status chips at the top and the top edge of
   * the panel. As the panel is resized between its snaps the pin slides to
   * follow, which also makes the relationship obvious — the map is getting out
   * of the panel's way rather than being covered by it.
   *
   * THE MATHS, since it is easy to get backwards. Panning is a pure
   * translation, so the screen-space gap between two points survives it. Pick
   * the coordinate Q sitting `(centre − target)` pixels BELOW the pin right
   * now; make Q the new centre; the pin lands exactly on the target row.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady || !destination) return;

    /**
     * Wait for the panel to finish growing before measuring around it.
     *
     * Its height is a 320 ms CSS transition; panning against the height it is
     * about to have, rather than the one it has, lands the pin in the right
     * place first time instead of chasing it.
     */
    const timer = setTimeout(() => {
      try {
        const size = map.getSize();
        const covered = Math.min(Math.max(bottomCoverFraction, 0), 0.95) * size.y;

        // The status chips and layer buttons, plus a little air. Anything under
        // this is technically visible and practically behind a control.
        const TOP_CHROME_PX = 64;
        const bottomEdge = size.y - covered;
        const band = bottomEdge - TOP_CHROME_PX;

        // Nothing usable left to aim at. Better to leave the view alone than to
        // shove the pin under a control.
        if (band < 80) return;

        // The teardrop hangs about 40 px above its coordinate, so aiming the
        // coordinate slightly low keeps the whole marker inside the strip.
        const targetY = Math.min(
          TOP_CHROME_PX + band / 2 + 14,
          bottomEdge - 12
        );

        const pin = map.latLngToContainerPoint([destination.latitude, destination.longitude]);
        const centre = map.containerPointToLatLng([pin.x, pin.y + (size.y / 2 - targetY)]);

        // Already close enough that moving would just look twitchy.
        const shift = map.latLngToContainerPoint(centre).distanceTo(map.getSize().divideBy(2));
        if (shift < 8) return;

        map.panTo(centre, prefersReducedMotion()
          ? { animate: false }
          : { animate: true, duration: 0.45 });
      } catch { /* map torn down mid-timeout */ }
    }, 70);

    return () => clearTimeout(timer);
    // `destination` identity changes when the user picks somewhere new, which
    // is exactly when this should re-run. A manual pan afterwards is left
    // alone — nothing here depends on the map's own move events.
  }, [destination, bottomCoverFraction, isMapReady]);

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
      setWarningBadges([]);
      return;
    }

    // TWO panes, because the two tiers behave differently.
    //
    //   warningPane      — the diffuse clouds and every tinted area fill. It is
    //                      pointer-events:none, so a tap on a cloud falls straight
    //                      through to the map (which drops a spot and shows the
    //                      warning in the sheet). Scenery, not a control.
    //   warningIconPane  — the precise fire/flood/storm icons. Interactive, and
    //                      above the campsite pins, because a flame on the map is
    //                      worth more than the pin beneath it and it has to be
    //                      tappable to open its card.
    if (!map.getPane('warningPane')) {
      map.createPane('warningPane');
      const wpane = map.getPane('warningPane');
      if (wpane) {
        wpane.style.zIndex = '460';
        wpane.style.pointerEvents = 'none';
        // The soft edge used to be a CSS filter on this whole pane. That forced
        // the compositor to re-rasterize the blurred output on every paint, and
        // during a pan or zoom that meant every animation frame: a six-pixel
        // blur over an area that moves with the map is the most expensive thing
        // the GPU can be asked to do. We now do the blur on each cloud path
        // instead, via an SVG <feGaussianBlur> the renderer owns (see below).
        // The browser can cache the filter output per element, and a pan
        // becomes a translate of already-rasterized layers rather than a
        // full re-blur of the pane every tick.
      }
    }
    // The tiled family glyph (thermometer / smoke / snowflake …) over each cloud.
    // Separate, un-blurred pane so the icons stay legible while the fill beneath
    // them is soft-edged.
    if (!map.getPane('warningGlyphPane')) {
      map.createPane('warningGlyphPane');
      const gpane = map.getPane('warningGlyphPane');
      if (gpane) { gpane.style.zIndex = '461'; gpane.style.pointerEvents = 'none'; }
    }
    if (!map.getPane('warningIconPane')) {
      map.createPane('warningIconPane');
      const ipane = map.getPane('warningIconPane');
      if (ipane) ipane.style.zIndex = '616';
    }

    // One SVG renderer for the cloud fills, one for the glyph tiles. SVG rather
    // than the boundary canvas because only SVG can carry the pattern fill the
    // repeating glyph needs.
    if (!warningRendererRef.current) {
      warningRendererRef.current = L.svg({ pane: 'warningPane', padding: 0.3 });
    }
    if (!warningGlyphRendererRef.current) {
      warningGlyphRendererRef.current = L.svg({ pane: 'warningGlyphPane', padding: 0.3 });
    }
    // Non-null: just created above if missing.
    const warningRenderer = warningRendererRef.current!;
    const glyphRenderer = warningGlyphRendererRef.current!;

    /**
     * THE BLUR — and why it lives on each path now, not on the pane.
     *
     * The first version put `filter: blur(6px)` on the whole warningPane,
     * which forced the compositor to re-blur every cloud on every paint —
     * a six-pixel blur over an area that moves with the map is the most
     * expensive thing the GPU can be asked to do, and a pan/zoom turned it
     * into every animation frame.
     *
     * The second version (the one being replaced here) tried an SVG
     * <feGaussianBlur> in the renderer's <defs>, with each cloud path
     * pointing at it via `filter="url(#…)"`. That was supposed to give
     * per-path caching, but it broke the clouds entirely:
     *
     *   1. The defs was injected on the FIRST effect run, BEFORE the
     *      renderer's `_container` had been created (Leaflet mints the SVG
     *      element lazily, the first time a layer is added to the map that
     *      uses this renderer). On a cold start, the defs injection was a
     *      no-op and the filter URL on every cloud path pointed at a filter
     *      that did not exist — the clouds drew as nothing.
     *   2. Even when the defs DID land, the per-path `eachLayer` walked
     *      `sub._path` BEFORE the layer was added to the group, when those
     *      path elements did not exist yet. The filter attribute was set on
     *      zero paths, so the clouds drew as nothing.
     *
     * The fix is per-element CSS filter, applied as an inline style on
     * each cloud path after it has been added to the map. The browser
     * caches each filtered element as its own compositing layer, and a
     * pan/zoom becomes a translate of those layers rather than a full
     * re-blur. There is no defs to inject, no path attribute to set after
     * the fact, and no first-render race.
     */

    let cancelled = false;
    let controller: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    // The area the current clouds were fetched for. A pan or zoom whose new
    // view still sits inside this padded box reuses what is already drawn
    // instead of refetching and rebuilding — which is what made the clouds
    // blink out and back on every gesture. Warnings do not depend on zoom, so
    // only leaving the loaded area triggers a refetch.
    let loadedAlertBox: L.LatLngBounds | null = null;
    // The latest fetch's request id. A slow older fetch that returns after
    // a newer one must NOT overwrite the newer data — without this guard,
    // a storm in Ontario can flicker when a slow refetch from a Calgary
    // pan lands after a fast Ontario refetch. The boundary effect uses the
    // same pattern; doing it here too is what stops the "shows up then
    // disappears" flicker on the cloud layer.
    let requestId = 0;

    /**
     * Draw the active warnings, split by tier.
     *
     *   DIFFUSE (smoke / heat / cold / wind) — a tinted area fill plus a slowly
     *   animated CLOUD at its centre. Non-interactive; the top-left legend says
     *   what each colour and icon means, and tapping a spot inside one surfaces
     *   the detail through the destination sheet.
     *
     *   PRECISE (fire / flood / storm) — a faint area hint plus a crisp, TAPPABLE
     *   icon at the centre. Tapping it opens the warning in the bottom card.
     *
     * Alerts the feed gave no geometry for are counted, never pinned to a guess.
     */
    const render = (alerts: HazardAlert[]) => {
      const placeable = alerts.filter((a) => Array.isArray(a.centroid) && a.geometry);

      const group = L.layerGroup([]);
      const present = new Set<AlertBadge>();
      // Diffuse glyph layers, wired to their patterns once the paths exist.
      const glyphTargets: { geo: L.GeoJSON; badge: 'heat' | 'smoke' | 'winter' | 'wind' | 'storm' }[] = [];
      // Diffuse cloud paths, with the centroid and radius they need for
      // their per-polygon radial gradient. Filled in below; the gradients
      // are written to the cloud renderer's <defs> AFTER the layer is on
      // the map, so the renderer's container is guaranteed to exist.
      const cloudTargetsList: {
        targets: { path: SVGPathElement; cx: number; cy: number; r: number }[];
        color: string;
      }[] = [];

      placeable.forEach((alert) => {
        const badge = alertBadge(alert);
        if (!badge) return;
        present.add(badge);
        const color = BADGE_COLOR[badge];

        if (isDiffuse(badge)) {
          // The cloud is a per-polygon radial gradient — opaque in the
          // middle, fully transparent at the polygon's bounding box edge —
          // plus a small per-path blur to soften the polygon outline itself.
          // The gradient does most of the work: a polygon filled with a
          // radial fade-out has no perceptible boundary, which is what
          // reads as "atmospheric" rather than "cartographic overlay".
          //
          // Why per-polygon gradients, not a single pane-level gradient:
          // two adjacent heat polygons are separate <path> elements with
          // different bounding boxes, and a single gradient stretched
          // across both would make one of them peak where the other should.
          // Each polygon gets its own gradient centred on its own
          // centroid, so the centre of each cloud is solid colour and
          // each edge fades independently. The gradients live in the
          // cloud renderer's <defs> and are rebuilt every render — a few
          // dozen small elements, the cost is invisible.
          //
          // The per-path CSS blur (12px) is a small additional softness
          // — it feathers the polygon's hard edge so the gradient's
          // "fully transparent" stops are not seen as a visible cutoff.
          const cloudGeo = L.geoJSON(alert.geometry as any, {
            pane: 'warningPane',
            renderer: warningRenderer,
            interactive: false,
            style: {
              stroke: false,
              fill: true,
              fillColor: color,
              fillOpacity: 1
            }
          } as RenderedGeoJSONOptions);
          group.addLayer(cloudGeo);
          // Build a centroid + bbox per path so the gradient is sized to
          // the actual ring, not the whole alert polygon (a MultiPolygon
          // has disjoint pieces, each with its own centroid).
          const cloudTargets: { path: SVGPathElement; cx: number; cy: number; r: number }[] = [];
          cloudGeo.eachLayer((sub) => {
            const el = (sub as unknown as { _path?: SVGPathElement })._path;
            if (!el) return;
            const ring = readRingFromPath(el);
            if (!ring) return;
            const { cx, cy, r } = centroidAndRadius(ring);
            cloudTargets.push({ path: el, cx, cy, r });
            // Light blur on the polygon's hard edge. The gradient does
            // most of the softening; this just feathers the cutoff.
            el.style.filter = 'blur(12px)';
          });
          cloudTargetsList.push({ targets: cloudTargets, color });
          // The same area, filled with the tiled family glyph — thermometers
          // for heat — in the crisp glyph pane above the blur. Wired to its
          // pattern in <defs> below.
          const glyphGeo = L.geoJSON(alert.geometry as any, {
            pane: 'warningGlyphPane',
            renderer: glyphRenderer,
            interactive: false,
            style: { stroke: false, fill: true, fillOpacity: 1 }
          } as RenderedGeoJSONOptions);
          group.addLayer(glyphGeo);
          glyphTargets.push({ geo: glyphGeo, badge: badge as 'heat' | 'smoke' | 'winter' | 'wind' | 'storm' });
        } else {
          // A faint hint of the area, so the icon has context, and the tappable
          // icon itself in the interactive pane above.
          group.addLayer(
            L.geoJSON(alert.geometry as any, {
              pane: 'warningPane',
              renderer: warningRenderer,
              interactive: false,
              style: { color, weight: 1.4, opacity: 0.55, fillColor: color, fillOpacity: 0.1 }
            } as RenderedGeoJSONOptions)
          );
          const marker = L.marker(alert.centroid as [number, number], {
            pane: 'warningIconPane',
            icon: L.divIcon({
              className: 'weather-warning-icon',
              html: preciseMarkerHtml(badge),
              iconSize: [36, 44],
              iconAnchor: [18, 44]
            }),
            title: `${alert.event} — tap for details`,
            riseOnHover: true
          });
          marker.on('click', () => alertTapRef.current?.(alert));
          group.addLayer(marker);
        }
      });

      // Swap: the fresh clouds go on the map before the old ones come off, so
      // there is no blank frame between one render and the next.
      const previous = hazardLayerRef.current;
      hazardLayerRef.current = group.addTo(map);
      if (previous) { try { map.removeLayer(previous); } catch { /* detached */ } }

      /**
       * Cloud radial gradients. Each polygon got a centroid + radius
       * computed from its own vertices; now that the layer is on the
       * map (and the renderer's container is guaranteed to exist), we
       * inject one <radialGradient> per cloud into the cloud renderer's
       * <defs> and point the polygon at it. Defs are wiped on every
       * render, so no accumulation.
       */
      const csvg = (warningRenderer as unknown as { _container?: SVGSVGElement })._container;
      if (csvg && cloudTargetsList.length) {
        let cdefs = csvg.querySelector('defs');
        if (!cdefs) {
          cdefs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
          csvg.insertBefore(cdefs, csvg.firstChild);
        }
        cdefs.innerHTML = '';
        let nextId = 0;
        for (const { targets, color } of cloudTargetsList) {
          for (const t of targets) {
            const id = `wl-cloud-${nextId++}`;
            // userSpaceOnUse so cx/cy/r are in the renderer's
            // coordinate space (lat/lon of the geometry), not the
            // polygon's bounding box. A gradient that scales to the
            // polygon's bbox would clip to a rectangle and look boxy;
            // user-space keeps it a true circle.
            const grad = document.createElementNS('http://www.w3.org/2000/svg', 'radialGradient');
            grad.setAttribute('id', id);
            grad.setAttribute('cx', String(t.cx));
            grad.setAttribute('cy', String(t.cy));
            grad.setAttribute('r', String(t.r));
            grad.setAttribute('gradientUnits', 'userSpaceOnUse');
            const stop0 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
            stop0.setAttribute('offset', '0%');
            stop0.setAttribute('stop-color', color);
            stop0.setAttribute('stop-opacity', '0.55');
            const stop100 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
            stop100.setAttribute('offset', '100%');
            stop100.setAttribute('stop-color', color);
            stop100.setAttribute('stop-opacity', '0');
            grad.appendChild(stop0);
            grad.appendChild(stop100);
            cdefs.appendChild(grad);
            t.path.setAttribute('fill', `url(#${id})`);
          }
        }
      }

      // Leaflet's style API has no pattern option, so each glyph pattern is
      // defined in the glyph renderer's <defs> and the cloud's glyph path is
      // pointed at it. Defs are rebuilt every render, so nothing accumulates.
      const gsvg = (glyphRenderer as unknown as { _container?: SVGSVGElement })._container;
      if (gsvg && glyphTargets.length) {
        let defs = gsvg.querySelector('defs');
        if (!defs) {
          defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
          gsvg.insertBefore(defs, gsvg.firstChild);
        }
        defs.innerHTML = '';
        const injected = new Set<string>();
        for (const { badge } of glyphTargets) {
          const pattern = warningGlyphPattern(badge);
          if (injected.has(pattern.id)) continue;
          injected.add(pattern.id);
          const parsed = new DOMParser()
            .parseFromString(
              `<svg xmlns="http://www.w3.org/2000/svg">${pattern.def}</svg>`,
              'image/svg+xml'
            )
            .documentElement.firstElementChild;
          if (parsed) defs.appendChild(document.importNode(parsed, true));
        }
        for (const { geo, badge } of glyphTargets) {
          const pattern = warningGlyphPattern(badge);
          geo.eachLayer((sub) => {
            const el = (sub as unknown as { _path?: SVGPathElement })._path;
            if (!el) return;
            el.setAttribute('fill', `url(#${pattern.id})`);
            el.setAttribute('fill-opacity', '1');
            el.setAttribute('stroke', 'none');
          });
        }
      }

      // Legend order: the diffuse cloud families first (they need the legend to
      // be understood at all), then the precise icons.
      const legendOrder: AlertBadge[] =
        ['smoke', 'heat', 'winter', 'wind', 'fire', 'flood', 'storm'];
      setWarningBadges(legendOrder.filter((b) => present.has(b)));
    };

    const run = async () => {
      const b = map.getBounds();
      // Still inside the area we last fetched for: the clouds already cover the
      // view, so leave them exactly as they are. This is the guard that stops
      // the constant refetch-and-rebuild on every small pan or zoom.
      if (loadedAlertBox && loadedAlertBox.contains(b)) return;

      controller?.abort();
      const myId = ++requestId;
      controller = new AbortController();

      // Fetch a generously padded box — three times the viewport in each
      // dimension — so a zoom-out from a centred view still sits inside
      // the loaded area and reuses the data. The 0.4 pad (a 1.4x box) was
      // tight enough that zooming out a level invalidated the loaded box
      // and triggered a refetch that, in the worst case, returned the
      // same alert with `centroid: null` for a moment and the cloud
      // disappeared mid-pan. 1.0 is the floor that keeps a multi-zoom-out
      // gesture from churning the layer.
      const padded = b.pad(1.0);
      const alerts = await fetchAreaAlerts(
        {
          minLat: padded.getSouth(), minLon: padded.getWest(),
          maxLat: padded.getNorth(), maxLon: padded.getEast()
        },
        controller.signal
      );
      // A newer fetch has started, OR the effect is unmounted. Either
      // way, do not write over fresher data.
      if (cancelled || myId !== requestId) return;

      loadedAlertBox = padded;
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
      // Drop the SVG renderers too, so a remount does not stack a second one.
      if (warningRendererRef.current) {
        try { map.removeLayer(warningRendererRef.current); } catch { /* detached */ }
        warningRendererRef.current = null;
      }
      if (warningGlyphRendererRef.current) {
        try { map.removeLayer(warningGlyphRendererRef.current); } catch { /* detached */ }
        warningGlyphRendererRef.current = null;
      }
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

  /** Icon for a pinned site, given its current selection and alert badges. */
  const iconForId = useCallback(
    (id: string) =>
      buildCampsiteIcon(selectedIdRef.current === id, badgesByIdRef.current.get(id) ?? []),
    []
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
        icon: iconForId(site.id),
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
  }, [pinnedCampsites, isMapReady, onSelectCampsite, onOpenDetailModal, iconForId]);

  // Swap only the two icons that changed.
  useEffect(() => {
    const previousId = selectedIdRef.current;
    const nextId = selectedCampsite?.id ?? null;
    if (previousId === nextId) return;
    // Update the ref first: iconForId reads it, and both pins need the new state.
    selectedIdRef.current = nextId;
    if (previousId) markersRef.current.get(previousId)?.setIcon(iconForId(previousId));
    if (nextId) markersRef.current.get(nextId)?.setIcon(iconForId(nextId));
  }, [selectedCampsite, iconForId]);

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
    const next = new Map<string, AlertBadge[]>();
    for (const site of pinnedCampsites) {
      const badges = hazards.length
        ? badgesForPoint(site.latitude, site.longitude, hazards)
        : [];
      if (badges.length) next.set(site.id, badges);
    }
    const prev = badgesByIdRef.current;
    badgesByIdRef.current = next;
    if (!isMapReady) return;

    /** A marker has changed only if its badge set has changed. */
    const sameBadges = (a: AlertBadge[] | undefined, b: AlertBadge[]): boolean => {
      if (!a) return b.length === 0;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };

    // Markers that USED to have a badge but no longer do.
    prev.forEach((badges, id) => {
      if (!next.has(id) && markersRef.current.has(id)) {
        markersRef.current.get(id)!.setIcon(iconForId(id));
      }
    });
    // Markers whose badge set changed.
    next.forEach((badges, id) => {
      if (!sameBadges(prev.get(id), badges) && markersRef.current.has(id)) {
        markersRef.current.get(id)!.setIcon(iconForId(id));
      }
    });
  }, [hazards, pinnedCampsites, isMapReady, iconForId]);

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
          <div class="absolute w-12 h-12 bg-blue-500/20 rounded-full animate-ping"></div>
          <div class="w-4 h-4 bg-blue-500 border-2 border-white rounded-full shadow-lg relative z-10"></div>
        </div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });

    userMarkerRef.current = L.marker(userLocation, { icon }).addTo(map);
  }, [userLocation, isMapReady]);

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

  /**
   * Center the map on a warning of `badge` and trace its perimeter once.
   *
   * WHAT IT DOES, IN ORDER:
   *   1. Pick the most prominent alert of that family in the current view.
   *      "Most prominent" = largest bbox area, which is the alert the user
   *      most plausibly meant by tapping its chip.
   *   2. Pan the map to the alert's centroid at the current zoom (no zoom
   *      change — that's the user's choice).
   *   3. Draw the alert's actual perimeter as a stroked SVG path, with
   *      `stroke-dasharray` set to its full length and `stroke-dashoffset`
   *      animated from that length to 0 over 1.5s. The line "draws itself"
   *      around the alert, then is removed.
   *
   * The tracer uses the same colour as the cloud (BADGE_COLOR) so the
   * user's eye links the chip they tapped to the area on the map without
   * having to read a label.
   */
  const focusWarning = useCallback((badge: AlertBadge) => {
    const map = mapRef.current;
    if (!map) return;

    // Pick the largest alert of this family in view. The bbox area is a
    // rough proxy for "the one that matters most" without going through a
    // full polygon-area calculation.
    const candidates = hazards
      .filter((a) => alertBadge(a) === badge && a.centroid && a.geometry)
      .map((a) => {
        const bbox = geometryBbox(a.geometry);
        const extent = bbox
          ? (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
          : 0;
        return { alert: a, extent };
      })
      .sort((a, b) => b.extent - a.extent);

    const chosen = candidates[0]?.alert;
    if (!chosen || !chosen.centroid || !chosen.geometry) return;

    // Clear any in-flight tracer from a previous tap. New tap wins, no
    // overlapping animations.
    if (tracerRef.current) {
      try { map.removeLayer(tracerRef.current); } catch { /* detached */ }
      tracerRef.current = null;
    }

    // Pan, but only if it actually moves the map. The flyTo guard above
    // would not help here because the user explicitly asked for a pan.
    map.panTo(chosen.centroid, { animate: true, duration: 0.5 });

    // Build the tracer as a non-interactive SVG layer in its own pane
    // above the cloud so the line is visible over the blurred fill.
    if (!map.getPane('tracerPane')) {
      map.createPane('tracerPane');
      const pane = map.getPane('tracerPane');
      if (pane) {
        pane.style.zIndex = '620';
        pane.style.pointerEvents = 'none';
      }
    }
    const tracerGeo = L.geoJSON(chosen.geometry as any, {
      pane: 'tracerPane',
      renderer: L.svg({ pane: 'tracerPane', padding: 0.2 }),
      interactive: false,
      style: {
        stroke: BADGE_COLOR[badge],
        weight: 3,
        opacity: 0.9,
        fill: false,
        // lineCap/Join matter for the visual: a rounded line reads as a
        // continuous tracer sweep, while butt caps look like a dashed line
        // marching in.
        lineCap: 'round',
        lineJoin: 'round',
        // We will set stroke-dasharray and animate stroke-dashoffset
        // imperatively once the path exists (see below).
      }
    } as unknown as RenderedGeoJSONOptions).addTo(map);

    // Compute the perimeter in screen pixels to set the dash pattern.
    // The tracer is a COMET, not a full-perimeter line: a small head of
    // `HEAD_LENGTH` (about 90px on screen — long enough to read as a
    // deliberate sweep, short enough to feel like a tracer rather than
    // an outline being drawn) followed by a gap so large that the rest
    // of the path is invisible. The head is animated by sliding the
    // dash offset; the gap is what hides the trailing perimeter.
    let perimeter = 0;
    tracerGeo.eachLayer((sub) => {
      const el = (sub as unknown as { _path?: SVGPathElement })._path;
      if (!el) return;
      try {
        const len = el.getTotalLength();
        if (len > perimeter) perimeter = len;
      } catch { /* non-renderable path; skip */ }
    });

    if (perimeter > 0) {
      const HEAD_LENGTH = 90;
      // The gap must be longer than the path, otherwise the head's "tail"
      // would butt up against the next iteration of the head as the offset
      // animates. A gap of (perimeter + 100) is comfortably beyond the path
      // length, so only the head is ever visible.
      const gap = perimeter + 100;
      // Two full loops so the user has time to register the tracer's path
      // around the alert. Anything less than 1.5 loops reads as a quick
      // flicker; more than 2.5 reads as indecisive. Two is the sweet spot
      // for the size of warning a camper is most likely tracing — a
      // county-wide heat advisory fits one full sweep in about a second.
      const loops = 2;
      const totalOffset = -loops * perimeter;

      tracerGeo.eachLayer((sub) => {
        const el = (sub as unknown as { _path?: SVGPathElement })._path;
        if (!el) return;
        el.style.setProperty('--tracer-head', String(HEAD_LENGTH));
        el.style.setProperty('--tracer-gap', String(gap));
        el.style.setProperty('--tracer-offset', String(totalOffset));
        el.style.strokeDasharray = `${HEAD_LENGTH} ${gap}`;
        el.style.strokeDashoffset = '0';
        // 2.2s for two loops, ease-in-out so the head accelerates
        // smoothly out of the start point and decelerates as it
        // approaches the end. A linear timing would feel mechanical;
        // a strong ease-in-out is what reads as "intentional".
        el.style.animation = 'wl-tracer-sweep 2.2s ease-in-out forwards';
      });
    }

    tracerRef.current = tracerGeo;
    setTracingBadge(badge);

    // One-shot: clear the tracer after the animation finishes. Keeping it
    // on screen would be visual noise; the user already saw where to look.
    window.setTimeout(() => {
      if (tracerRef.current === tracerGeo && mapRef.current) {
        try { mapRef.current.removeLayer(tracerGeo); } catch { /* detached */ }
        tracerRef.current = null;
      }
      setTracingBadge((current) => (current === badge ? null : current));
    }, 2400);
  }, [hazards]);

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
      <div ref={stageRef} className="map-stage absolute inset-0">
        <div ref={containerRef} className="w-full h-full" />
      </div>
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

        {/*
          The weather-warning legend. The overlays themselves cannot be tapped,
          so this is what tells a camper what the coloured, animated clouds mean
          — a colour swatch and an icon per active family. Tapping a campsite
          pin inside a warning is what surfaces the detail, in the bottom card.
        */}
        {warningBadges.length > 0 && (
          <div className="bg-slate-900/92 backdrop-blur-md border border-amber-600/50 rounded-xl px-3 py-2 shadow-xl anim-in-up max-w-[15rem]">
            <div className="flex items-center gap-1.5 mb-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span className="text-[11px] font-bold text-amber-100">
                Weather warnings here
              </span>
            </div>
            <ul className="space-y-1">
              {warningBadges.map((b) => {
                const isTracing = tracingBadge === b;
                return (
                  <li key={b}>
                    <button
                      type="button"
                      onClick={() => focusWarning(b)}
                      aria-label={`Centre the map on ${WARNING_LABEL[b]} warning and trace it`}
                      className={`w-full flex items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-moook ${
                        isTracing
                          ? 'bg-amber-500/15 ring-1 ring-amber-400/40'
                          : 'hover:bg-slate-800/60'
                      }`}
                    >
                      <span
                        className="w-3.5 h-3.5 rounded-sm shrink-0 border border-slate-950/50"
                        style={{ background: BADGE_COLOR[b] }}
                      />
                      <span className="text-xs leading-none" aria-hidden="true">
                        {WARNING_EMOJI[b]}
                      </span>
                      <span className="text-[10px] text-slate-200 font-semibold flex-1">
                        {WARNING_LABEL[b]}
                      </span>
                      {isTracing && (
                        <span className="text-[9px] text-amber-300 font-bold uppercase tracking-wider">
                          tracing
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            {unmappableHazards > 0 && (
              <p className="text-[9px] text-amber-300/80 leading-tight mt-1.5">
                {unmappableHazards} more with no mapped area — tap a spot to read
                {unmappableHazards === 1 ? ' it' : ' them'}.
              </p>
            )}
            <p className="text-[9px] text-slate-500 leading-tight mt-1">
              Shaded, animated clouds are area warnings — tap a spot inside one for
              details. Fire and flood show a tappable icon instead. Tap a row above to
              centre the map on that warning.
            </p>
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
        Zoom, in React rather than Leaflet.

        Leaflet's own control would live inside the stage element and inherit
        anything ever done to it; these sit outside as siblings of the map, next
        to the rest of the chrome.
      */}
      <div className="absolute bottom-6 right-3 z-[1000] flex flex-col rounded-xl overflow-hidden border border-slate-700/80 shadow-xl">
        <button
          type="button"
          onClick={() => mapRef.current?.zoomIn()}
          className="w-9 h-9 bg-slate-900/90 backdrop-blur-md text-slate-200 hover:text-white hover:bg-slate-800 text-lg font-bold leading-none"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => mapRef.current?.zoomOut()}
          className="w-9 h-9 bg-slate-900/90 backdrop-blur-md text-slate-200 hover:text-white hover:bg-slate-800 text-lg font-bold leading-none border-t border-slate-700/80"
          aria-label="Zoom out"
        >
          −
        </button>
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
          className="w-5 h-5 rounded-full bg-slate-950/60 backdrop-blur-sm border border-slate-700/50 text-slate-400 hover:text-slate-100 hover:bg-slate-900/80 flex items-center justify-center shrink-0"
          aria-label={showCredits ? 'Hide map credits' : 'Show map credits'}
          aria-expanded={showCredits}
        >
          <Info className="w-3 h-3" />
        </button>

        {showCredits && (
          <div
            className="px-2 py-1 rounded-md bg-slate-950/90 backdrop-blur-sm border border-slate-700/60 text-[9px] text-slate-300 max-w-[70vw] anim-in-up"
            dangerouslySetInnerHTML={{
              __html: isOfflineMode
                ? 'Offline tile cache'
                : TILE_URLS[activeTileLayer].attribution
            }}
          />
        )}
      </div>

      {/*
        The one instruction on the map.

        Shown only until the user has picked somewhere. A tap target that
        covers the entire screen is invisible until somebody tells you it's
        there — but once you know, the hint is clutter, so it removes itself.
      */}
      {!destination && (
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
