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
import { fetchActiveFires, isUnderControl, ActiveFire } from '../services/fireService';
import { fetchAdmin1, Admin1, primeAdmin1, findAdmin1At } from '../services/admin1Service';
import { isOnLand, primeLandMask } from '../services/landService';
import {
  buildFuzzRings, ringBudget, edgeBlurPx, UNCERTAINTY_LABEL, shouldSimplify
} from '../utils/fuzzyBoundary';
import {
  AlertBadge, BADGE_COLOR, badgesForPoint, alertBadge,
  hazardCloudHtml, preciseMarkerHtml, isDiffuse, warningGlyphPattern, explodeToFeatures,
  WARNING_LABEL, dissolveKey, dissolveSegments, dissolvedFill
} from '../utils/alertOverlay';
import {
  MarkerDot, amenityDots, hazardDots, COLLAPSED_DOT_LIMIT
} from '../utils/amenityDots';
import {
  BoundingBox, MAP_VIEW_BBOX, COVERAGE_OUTLINE, WORLD_RING, VIEW_RING,
  BOUNDARY_MIN_ZOOM, BOUNDARY_OVERVIEW_MIN_ZOOM, overviewMinAreaSqKm,
  COVERAGE_LABEL, isWithinCoverage, landDataGap
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
 * How close the camera comes when a camper taps a pin.
 *
 * Close enough that the tapped pin's expanded chips have the screen to
 * themselves and the roads in to the spot are drawn; not so close that the
 * surroundings vanish and the camper loses the sense of where the spot sits.
 * Never zooms OUT to reach it — see the effect that uses it.
 */
const CAMPSITE_FOCUS_ZOOM = 14;

/**
 * The frame the map lives in — the box the user pans inside and cannot
 * drag out of, with an equal margin on all four sides.
 *
 * Note this is `MAP_VIEW_BBOX`, not `COVERAGE_BBOX`. Pinning the
 * pannable area to the data area sounds tidy and looks wrong: it jams
 * the Pacific coast and the Gulf against the edges of the screen with
 * no breathing room, and it makes the coverage line unreachable at the
 * exact moment you want to see where it runs. The view gets the margin;
 * the data keeps its tight box.
 */
const PAN_BOUNDS = L.latLngBounds(
  [MAP_VIEW_BBOX.minLat, MAP_VIEW_BBOX.minLon],
  [MAP_VIEW_BBOX.maxLat, MAP_VIEW_BBOX.maxLon]
);

/**
 * The only part of the planet any tile layer is allowed to fetch.
 *
 * It is `PAN_BOUNDS`, deliberately — the frame is the furthest the user
 * can ever pan, so a tile outside it can never be looked at. It can
 * still be DOWNLOADED, though, and it was: the layers were bounded to
 * the whole world, so zooming out on a wide screen quietly pulled in
 * the Atlantic, Europe, west Africa and a slice of South America.
 * Every one of those tiles is a request, a decode and a chunk of
 * memory spent drawing places this app has nothing to say about, under
 * a grey mask that hides them anyway.
 *
 * Bounding the layers to the frame means they are never requested at
 * all. Where the screen is a different shape from the frame, the band
 * left over is filled by the matte in the coverage-mask effect rather
 * than by imagery.
 *
 * (`noWrap` stays on every layer alongside this. Without it Leaflet
 * tiles the world infinitely sideways — the "three copies of Earth"
 * bug, where the mask is a single polygon and only covers the middle
 * copy.)
 */
const TILE_BOUNDS = PAN_BOUNDS;

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

const TENT_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px">' +
  '<path d="M19 20 12 4 5 20"/><path d="M12 4v16"/><path d="M2 20h20"/></svg>';

/**
 * A spot a camper added themselves.
 *
 * TWO STATES, AND THE WHOLE INTERFACE HANGS OFF THE DIFFERENCE.
 *
 * HOLLOW is the resting state: a ring, not a blob. A screenful of solid
 * discs is a screenful of paint over the terrain a camper is trying to read,
 * and every one of them shouts equally hard. A ring lets the ground through
 * and still reads as "a spot is here" at a glance.
 *
 * FILLED is the tapped state: the ring floods with colour and pops once, so
 * "the one I chose" is unmistakable among its neighbours without the others
 * having to dim.
 *
 * Above the pin, either way, sits a row of small coloured dots — one per fact
 * recorded about the spot, hazards first. That row is what used to be a
 * legend in the corner of the map. Tapped, each dot expands into the words it
 * stood for, so the key to the colours is on the thing the colours describe.
 *
 * A dot only ever stands for something somebody recorded. See `amenityDots`.
 */
const buildCampsiteIcon = (isSelected: boolean, dots: MarkerDot[] = []): L.DivIcon => {
  const overflow = Math.max(0, dots.length - COLLAPSED_DOT_LIMIT);

  /** Resting: colour only, no words. The pin is the label. */
  const collapsedRow = (): string => {
    const shown = dots.slice(0, COLLAPSED_DOT_LIMIT);
    const cells = shown
      .map(
        (d) =>
          `<i class="wl-dot${d.tone === 'bad' ? ' wl-dot-bad' : ''}" ` +
          `style="background:${d.color}"></i>`
      )
      .join('');
    const more = overflow
      ? `<i class="wl-dot wl-dot-more" style="background:#475569"></i>`
      : '';
    return `<div class="wl-dots">${cells}${more}</div>`;
  };

  /** Tapped: the same dots, each grown into the fact it stood for. */
  const expandedRow = (): string => {
    const chips = dots
      .map(
        (d, i) =>
          `<span class="wl-chip${d.tone === 'bad' ? ' wl-chip-bad' : ''}" ` +
          `style="--wl-chip-color:${d.color};animation-delay:${i * 26}ms">` +
          `<i class="wl-chip-dot" style="background:${d.color}"></i>` +
          `<span class="wl-chip-glyph" aria-hidden="true">${d.glyph}</span>` +
          `${escapeHtml(d.label)}</span>`
      )
      .join('');
    return `<div class="wl-chips">${chips}</div>`;
  };

  const row = dots.length ? (isSelected ? expandedRow() : collapsedRow()) : '';

  return L.divIcon({
    className: 'custom-campsite-marker',
    html:
      `<div class="wl-pin-wrap${isSelected ? ' wl-pin-wrap-on' : ''}">` +
      row +
      `<div class="wl-pin${isSelected ? ' wl-pin-on' : ''}">${TENT_SVG}</div>` +
      `</div>`,
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
 * Centre and semi-axes of the ELLIPSE that covers a drawn ring, in the SVG
 * renderer's own units (screen pixels at the current zoom, not degrees —
 * the ring was read back out of a projected `d` attribute).
 *
 * WHY AN ELLIPSE AND NOT A CIRCLE. This feeds a userSpaceOnUse
 * radialGradient that tints the warned area. The previous version used a
 * single radius of half the SMALLER bbox dimension, which on a wide
 * warning — a heat advisory spanning several counties east to west but
 * only one or two north to south — drew a small circle of colour in the
 * middle of a very long polygon. The tiled thermometers filled the whole
 * shape while the red only reached a fraction of it, so the colour and
 * the icons disagreed about how big the warning was.
 *
 * Sizing the gradient to BOTH bbox dimensions makes the tint cover the
 * same ground the glyphs do. The centre is the bbox centre rather than
 * the mean of the vertices: vertex density varies wildly in agency
 * polygons (a coastline edge carries hundreds of points, a straight
 * county line carries two), and a mean pulled toward the busy edge puts
 * the bright part of the cloud off to one side of the area it describes.
 *
 * The 1.14 pad pushes the fully transparent stop just past the bbox, so
 * the polygon's corners still carry colour instead of falling outside
 * the ellipse and reading as clipped-off patches. The edge stays soft
 * because the last third of the gradient is already nearly transparent
 * by the time it reaches the boundary, and the per-path blur feathers
 * whatever is left.
 */
const cloudEllipse = (
  ring: [number, number][]
): { cx: number; cy: number; rx: number; ry: number } => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const PAD = 1.14;
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    // A degenerate ring (every vertex on one line) would give a zero
    // axis, which makes the gradient transform non-invertible and the
    // fill vanish. Floor both axes at a sub-pixel value.
    rx: Math.max(0.5, (PAD * (maxX - minX)) / 2),
    ry: Math.max(0.5, (PAD * (maxY - minY)) / 2)
  };
};

/**
 * A cheap content fingerprint for a boundary collection.
 *
 * Answers one question: is this the same set of parcels the map is already
 * drawing? A refetch — triggered by panning past the edge of the loaded box —
 * hands back a brand new response object, and comparing object identity says
 * "different" even when every parcel in it is one already on screen. Acting on
 * that meant rebuilding the entire layer for no visible change, which is what
 * made panning feel like the map was constantly redrawing itself.
 *
 * A parcel is identified by its source, name and designation plus its first
 * vertex rounded to about a metre. Two genuinely different parcels sharing all
 * four is not a thing the feeds produce; two responses describing the same
 * parcel always agree on all four. The order the server returns them in is not
 * guaranteed, so the parts are sorted before joining.
 *
 * Cost is one pass over the features with no geometry maths — trivial next to
 * the dissolve pass and layer rebuild it exists to avoid.
 */
const fingerprintCache = new WeakMap<BoundaryCollection, string>();

const parcelFingerprint = (collection: BoundaryCollection): string => {
  const memo = fingerprintCache.get(collection);
  if (memo !== undefined) return memo;

  const parts = collection.features.map((f) => {
    const p = f.properties ?? ({} as BoundaryFeature['properties']);
    const g = f.geometry as { coordinates?: unknown };

    // Walk to the first coordinate pair, whatever the nesting depth, and
    // count the vertices on the way past.
    let vertices = 0;
    let first = '';
    const walk = (node: unknown): void => {
      if (!Array.isArray(node)) return;
      if (typeof node[0] === 'number' && typeof node[1] === 'number') {
        vertices += 1;
        if (!first) first = `${(node[0] as number).toFixed(5)},${(node[1] as number).toFixed(5)}`;
        return;
      }
      node.forEach(walk);
    };
    walk(g?.coordinates);

    /**
     * The vertex count is the part that stops this being too clever.
     *
     * Zooming in refetches the same parcels at FINER generalisation — same
     * source, same name, same first vertex, more detail. Without the count
     * they fingerprint identically, the rebuild is skipped as "no change",
     * and the map keeps drawing the coarse outline it already had while
     * claiming to be at full detail. Edges that are more approximate than the
     * app says they are is exactly the failure this codebase refuses to ship.
     */
    return `${p._source ?? ''}~${p._name ?? ''}~${p._designation ?? ''}~${first}~${vertices}`;
  });
  parts.sort();
  const out = `${parts.length}#${parts.join('|')}`;

  // Memoised per response object: `fetchBoundaries` hands back the same object
  // for a cache hit, so a settled pan costs a WeakMap lookup rather than a
  // fresh walk over every vertex on screen.
  fingerprintCache.set(collection, out);
  return out;
};

/* ------------------------------------------------------------------ */
/* Active fire rendering                                                */
/* ------------------------------------------------------------------ */

/**
 * Flame colours. One pair, used by the icon, the perimeter outline and
 * the layer-menu key, so the three can never drift apart.
 *
 *   red    — still running. The agency has not reported it under control.
 *   orange — reported held / contained / under control. Still burning,
 *            still worth knowing about, just not spreading.
 */
const FIRE_COLOR = {
  running: { fill: '#EF4444', stroke: '#450A0A' },   // red-500 on red-950
  controlled: { fill: '#F97316', stroke: '#431407' } // orange-500 on orange-950
} as const;

/**
 * The flame drawn at a fire's location. US and Canada, perimeter and
 * point — the same icon every time.
 *
 * It used to be Canada-only: a US fire was a bare red polygon outline
 * with no marker, so at any zoom where the perimeter was smaller than a
 * fingertip there was nothing to see and nothing to tap. Now the flame
 * marks every fire and the polygon is the extra detail on top of it.
 *
 * There is no white disc behind the flame any more. The halo made every
 * fire look like a UI button pinned to the map; a dark outline on the
 * flame plus a drop shadow (see `.wl-fire-flame` in index.css) keeps it
 * readable over satellite imagery without the chrome.
 *
 * Inline SVG so a single divIcon is one DOM node. `paint-order: stroke`
 * puts the dark edge outside the fill, so the flame keeps its shape
 * instead of being eaten by its own outline.
 */
const buildFirePointHtml = (underControl: boolean): string => {
  const c = underControl ? FIRE_COLOR.controlled : FIRE_COLOR.running;
  return `
  <div class="wl-fire-flame">
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
        fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6"
        stroke-linejoin="round" stroke-linecap="round" paint-order="stroke" />
    </svg>
  </div>
`;
};

/**
 * Escape user-supplied text before it goes into a popup. The fire name
 * is from the issuing agency (WFIGS or FireRadar), so the worst case is
 * a misformatted upstream record, but a stray `<script>` tag in a name
 * would land in innerHTML; escape it.
 */
const escapeHtml = (s: string): string => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const formatSize = (fire: ActiveFire): string => {
  // Prefer hectares (CA reports in ha, US in acres). The other field is
  // a derived approximation, so a single number with a unit is the
  // honest thing to show.
  if (fire.sizeHa != null && fire.sizeHa >= 0.1) {
    return `${fire.sizeHa.toFixed(fire.sizeHa < 10 ? 1 : 0)} ha`;
  }
  if (fire.sizeAcres != null && fire.sizeAcres >= 0.1) {
    return `${Math.round(fire.sizeAcres).toLocaleString()} acres`;
  }
  if (fire.sizeHa != null) return '< 0.1 ha';
  if (fire.sizeAcres != null) return '< 0.1 acres';
  return 'size unknown';
};

/**
 * Popup body for a fire — what the user gets when they tap a perimeter
 * outline or a flame dot. Two lines of header (name + region), then a
 * small table of attributes, all from the upstream record.
 */
const buildFirePopupHtml = (fire: ActiveFire): string => {
  const controlled = isUnderControl(fire);
  const rows: Array<[string, string]> = [];
  rows.push(['Size', formatSize(fire)]);
  if (fire.contained != null) {
    rows.push(['Contained', `${Math.round(fire.contained)}%`]);
  }
  if (fire.status) {
    rows.push(['Status', escapeHtml(fire.status)]);
  }
  if (fire.discovered) {
    const d = new Date(fire.discovered);
    if (Number.isFinite(d.getTime())) {
      rows.push(['Discovered', d.toISOString().slice(0, 10)]);
    }
  }
  if (fire.cause) {
    rows.push(['Cause', escapeHtml(fire.cause)]);
  }
  const source = fire.country === 'US' ? 'WFIGS / NIFC' : 'FireRadar (provincial feeds)';

  const rowsHtml = rows.map(([k, v]) =>
    `<div class="flex justify-between text-[11px] py-0.5">
       <span class="text-slate-400">${escapeHtml(k)}</span>
       <span class="text-slate-100 font-semibold">${v}</span>
     </div>`
  ).join('');

  /**
   * The colour has to say what it means somewhere, and the popup is the
   * one place the user is already asking "what is this?". The wording is
   * careful: "not reported under control" is what we actually know, and
   * is not the same claim as "out of control".
   */
  const c = controlled ? FIRE_COLOR.controlled : FIRE_COLOR.running;
  const stateText = controlled
    ? 'Reported under control'
    : 'Not reported under control';

  return `
    <div class="font-sans text-slate-100 min-w-[180px]">
      <div class="text-[13px] font-bold leading-tight">${escapeHtml(fire.name)}</div>
      <div class="text-[10px] uppercase tracking-wider text-slate-400 mb-2">${escapeHtml(fire.region)}</div>
      <div class="flex items-center gap-1.5 mb-2">
        <span style="width:8px;height:8px;border-radius:9999px;background:${c.fill};display:inline-block;flex:none"></span>
        <span class="text-[10px] font-bold" style="color:${c.fill}">${stateText}</span>
      </div>
      <div class="border-t border-slate-700 pt-1.5">${rowsHtml}</div>
      <div class="text-[9px] text-slate-500 mt-1.5">Source: ${source}</div>
    </div>
  `;
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
  /**
   * Fired when a tap is rejected — pin in water, or pin in the
   * bit of the pannable box that falls outside the precise
   * coverage polygon (a sliver of northern Mexico, say). The
   * reason chooses which notice to show.
   */
  onPinRefused?: (reason: 'water' | 'outside_coverage') => void;
  /** Fired when a camper's hazard report is tapped. */
  onSelectHazardReport?: (record: HazardRecord) => void;
  /** Fired when a precise official warning (fire / flood / storm) is tapped. */
  onSelectAlert?: (alert: HazardAlert) => void;
}

/**
 * The map as the clustering plugin needs to see it: whole-number minimum zoom.
 *
 * Leaflet.markercluster asks the map for its minimum zoom in two different
 * ways — floored when it builds its tree of cluster levels, raw when it
 * decides which of those levels may be drawn. Our minimum is a fraction on
 * purpose (see `applyMinZoom`), so those two answers disagree by part of a
 * level, the top of the tree lands outside the drawable range, and any pin
 * that isn't grouped with another one is created, counted and then never put
 * on the map. That is the "I added a spot and no pin appeared" bug.
 *
 * So answer that one question with a whole number and leave the map itself
 * alone — the fractional minimum is what keeps the frame filling the screen.
 * Zero rather than the floor of the current minimum, because the real minimum
 * is recomputed on every resize, and a tree built against a stale answer
 * breaks in exactly the same silent way.
 */
const clusterView = (map: L.Map): L.Map =>
  new Proxy(map, {
    get: (target, prop) => (prop === 'getMinZoom' ? () => 0 : Reflect.get(target, prop)),
    set: (target, prop, value) => Reflect.set(target, prop, value)
  });

export const MapComponent: React.FC<MapComponentProps> = ({
  campsites, selectedCampsite, onSelectCampsite, center, zoom, userLocation,
  isOfflineMode, onOpenDetailModal, onLocateUser,
  isLocating = false,
  destination, onDropDestination, onPinRefused, onSelectHazardReport, onSelectAlert,
  bottomCoverFraction = 0
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  /** `mapRef.current` seen through `clusterView`; the cluster group's map. */
  const clusterViewRef = useRef<L.Map | null>(null);
  const userMarkerRef = useRef<L.Marker | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const underlayLayerRef = useRef<L.TileLayer | null>(null);
  const boundaryLayerRef = useRef<L.LayerGroup | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  /** Alert badges affecting each pinned campsite, keyed by id. */
  const badgesByIdRef = useRef<Map<string, AlertBadge[]>>(new Map());
  /**
   * The destination the camera has already closed in on.
   *
   * Compared by identity, so re-parking the pin as the panel is dragged
   * between snaps never re-runs the zoom.
   */
  const focusedDestRef = useRef<MapDestination | null>(null);

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
  /** Active-fire layer (perimeters + points). Cleared when `showFires` is off. */
  const fireLayerRef = useRef<L.LayerGroup | null>(null);
  /** State / province boundary lines. Cleared when `showAdmin1` is off. */
  const admin1LayerRef = useRef<L.LayerGroup | null>(null);
  const warningRendererRef = useRef<L.Renderer | null>(null);
  const warningGlyphRendererRef = useRef<L.Renderer | null>(null);
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
  /**
   * Weather warning overlay (clouds + flame icons). ON by default because
   * warnings are the safety feature, and a camper who has the layer off
   * still gets a heads-up on the destination sheet and campsite bottom
   * sheet (the per-pin hazard panel reads from `hazards` state, not from
   * this toggle, so a hidden layer does not silence the pin card).
   */
  const [showWarnings, setShowWarnings] = useState(true);
  /**
   * Active-fire layer. ON by default.
   *
   * The comment here used to say the toggle did nothing because there was no
   * fire data source yet. There is one — /api/fires merges the US WFIGS
   * perimeters with the Canadian FireRadar points — and defaulting the layer
   * off meant a camper had to know the toggle existed before the app would
   * show them a fire burning where they were headed. Same reasoning as the
   * warning layer above: this is the safety feature, so it starts on.
   */
  const [showFires, setShowFires] = useState(true);
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
  const [isLoadingBoundaries, setIsLoadingBoundaries] = useState(false);
  const [zoomTooFar, setZoomTooFar] = useState(false);
  /** True while the map is showing the large-parcels-only overview. */
  const [isOverviewTier, setIsOverviewTier] = useState(false);
  const [hazards, setHazards] = useState<HazardAlert[]>([]);
  const [unmappableHazards, setUnmappableHazards] = useState(0);
  /** Which warning families are drawn in view — drives the top-left legend. */
  const [warningBadges, setWarningBadges] = useState<AlertBadge[]>([]);
  /** Camper-filed reports currently on screen — counted in the status chip. */
  const [hazardReports, setHazardReports] = useState<HazardRecord[]>([]);
  /**
   * The state or province under the middle of the screen.
   *
   * Used for one thing: telling a camper in a province this app has no Crown
   * land data for that the empty map is a gap in the data, not an absence of
   * public land. Null while the outlines load, or outside the US and Canada.
   */
  const [viewJurisdiction, setViewJurisdiction] = useState<Admin1 | null>(null);

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
     * `getBoundsZoom` asks the right question instead: how far out can we
     * go before the frame stops fitting? Zooming out past that only ever
     * reveals the parts of the world this app has nothing to say about.
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
       * Fractional on purpose. `getBoundsZoom` would floor this to a
       * whole level, and on a phone the fit lands around 2.65 — so
       * flooring to 2 halves the scale and leaves the continent as a
       * small rectangle adrift in a field of grey. Landing exactly on
       * the fit means the frame meets the left and right edges of the
       * screen at full zoom-out, which is the shape of the thing.
       *
       * Computed rather than asked for, because `getBoundsZoom` also
       * clamps its answer to the minimum currently in force — so once
       * this had been set, widening the window could never lower it
       * again, and the map would stay stuck at the phone-sized minimum.
       */
      const next = Math.log2(Math.min(size.x / frameWidth, size.y / frameHeight));

      map.setMinZoom(next);

      /**
       * Fully zoomed out means one exact view, so snap to it.
       *
       * At the minimum the frame either fits the screen exactly in one
       * dimension and is letterboxed in the other, or fits both. Either
       * way there is nowhere to pan to — so the view is completely
       * determined, and it should be the frame, dead centre, with the
       * leftover band split evenly between the two edges.
       *
       * Leaflet gets there on its own most of the time, but not after a
       * resize: `invalidateSize` shifts the view without re-running the
       * bounds clamp, so rotating a phone could leave the continent
       * sitting high or low in the frame with all the grey below it.
       *
       * The centre is measured in PROJECTED space, not by averaging the
       * corner latitudes. Mercator stretches the north, so the halfway
       * latitude and the halfway pixel are two different places — about
       * four degrees apart over a frame this tall, which is a visibly
       * off-centre map.
       */
      if (map.getZoom() <= next + 1e-9) {
        const middle = map.unproject(
          map.project(PAN_BOUNDS.getNorthWest(), next)
            .add(map.project(PAN_BOUNDS.getSouthEast(), next))
            .divideBy(2),
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
     * It used to sit at 450 — under the warning clouds, the fire
     * perimeters, the camper reports and the pins. Anything whose shape
     * crossed the coverage line therefore carried on drawing at full
     * strength over the grey: a heat cloud reaching down into Mexico, a
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
  /* Which state or province is on screen                                */
  /* ------------------------------------------------------------------ */
  /**
   * Kept only so the status chip can name a province that has no Crown land
   * data. Cheap: the admin-1 outlines are a prebuilt file already loaded for
   * the boundary lines, and this is one point-in-polygon test against a
   * bbox-prefiltered list, debounced, per settled view.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const check = () => {
      const c = map.getCenter();
      void findAdmin1At(c.lat, c.lng).then((hit) => {
        if (cancelled) return;
        // Compare by code so an identical result never re-renders.
        setViewJurisdiction((prev) =>
          prev?.isoCode === hit?.isoCode ? prev : hit
        );
      });
    };

    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(check, 300);
    };

    schedule();
    map.on('moveend', schedule);
    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      map.off('moveend', schedule);
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
      renderedFingerprintRef.current = null;
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
        renderedFingerprintRef.current = fingerprint;
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
      renderedFingerprintRef.current = fingerprint;
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
      // The spinner is for a camper waiting on an EMPTY map. Once parcels are
      // drawn, a top-up fetch for the next box along is background work they
      // did not ask about, and flipping the status chip to "Loading
      // boundaries…" and back on every pan is a large part of what made this
      // feel busy. Say nothing while there is already something to look at.
      const showsProgress = !boundaryLayerRef.current;
      if (showsProgress) setIsLoadingBoundaries(true);

      const collection = await fetchBoundaries(box, controller.signal, detail, currentZoom);
      if (cancelled || myId !== requestId) return;

      if (showsProgress) setIsLoadingBoundaries(false);
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

        /**
         * Tapping a pin also moves the camera IN.
         *
         * A tapped pin has just unfolded its dots into a stack of labelled
         * chips, and at the zoom you were browsing at those chips overlap
         * the pins around them. Closing in gives the expanded pin the room
         * it needs and answers the question the tap asked — "what is this
         * place?" — with the ground around it, not just a card.
         *
         * Only ever in, never out: the zoom you chose to browse at is yours,
         * and yanking the view back out from under a camper who had zoomed
         * to a road junction would be worse than not moving at all. And only
         * once per selection, so dragging the panel between its snaps
         * afterwards re-parks the pin without re-zooming.
         */
        const first = focusedDestRef.current !== destination;
        focusedDestRef.current = destination;
        const zoomTo = first && destination.campsite
          ? Math.max(map.getZoom(), CAMPSITE_FOCUS_ZOOM)
          : map.getZoom();

        // Projected at the zoom we are GOING to, not the one we are at:
        // the pixel offset that parks the pin above the panel is only
        // correct in the scale it is measured in.
        const pin = map.project([destination.latitude, destination.longitude], zoomTo);
        const centre = map.unproject(
          pin.add(L.point(0, size.y / 2 - targetY)),
          zoomTo
        );

        // Already close enough that moving would just look twitchy.
        const shift = map.latLngToContainerPoint(centre).distanceTo(map.getSize().divideBy(2));
        if (shift < 8 && zoomTo === map.getZoom()) return;

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

    // Layer off: clear the existing clouds and skip the fetch. The
    // hazard state is intentionally NOT cleared — the per-pin
    // destination sheet and campsite bottom sheet read from `hazards`
    // directly, so a hidden layer does not silence the pin card. A
    // camper who has the layer off still sees "Heat advisory nearby"
    // on the pin they're considering — which is the point of having
    // the layer toggleable without losing safety context.
    if (!showWarnings) {
      clear();
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
     * The diffuse cloud layers currently on the map, with the colour each one
     * paints. Kept so the gradients can be re-measured after a zoom.
     */
    let drawnClouds: { geo: L.GeoJSON; color: string }[] = [];

    /**
     * TURN THE CLOUD POLYGONS INTO CLOUDS.
     *
     * MUST run with the layers already added to the MAP. Leaflet mints a
     * Path's `_path` element in `onAdd`; adding a layer to a detached
     * LayerGroup creates nothing. The previous version measured `_path` at
     * build time, always found `undefined`, and so every cloud kept its flat
     * `fillOpacity: 1` fill — an opaque slab with a hard edge, which is not
     * what a smoke plume or a heat mass is supposed to look like.
     *
     * Each drawn ring gets its own radial gradient: solid at the centre, fully
     * transparent at the rim, in the renderer's own coordinate space so it
     * stays a true circle rather than stretching to the polygon's bounding
     * box. A MultiPolygon's pieces are disjoint, so each piece is measured
     * separately — one gradient across all of them would peak in the gap
     * between two of them. A light per-path blur feathers the polygon edge so
     * the gradient's transparent stop is never seen as a cutoff.
     *
     * Re-run on zoom: Leaflet re-projects each path's `d` when the zoom
     * settles, so the coordinates the gradients were built from are stale and
     * the soft centre would drift off the warned area.
     */
    const paintClouds = (): void => {
      const csvg = (warningRenderer as unknown as { _container?: SVGSVGElement })._container;
      if (!csvg) return;

      let cdefs = csvg.querySelector('defs');
      if (!cdefs) {
        cdefs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        csvg.insertBefore(cdefs, csvg.firstChild);
      }
      // Rebuilt from scratch every time, so gradients never accumulate.
      cdefs.innerHTML = '';
      let nextId = 0;

      for (const { geo, color } of drawnClouds) {
        geo.eachLayer((sub) => {
          const el = (sub as unknown as { _path?: SVGPathElement })._path;
          if (!el) return;
          const ring = readRingFromPath(el);
          if (!ring) return;
          const { cx, cy, rx, ry } = cloudEllipse(ring);

          const id = `wl-cloud-${nextId++}`;
          const grad = document.createElementNS('http://www.w3.org/2000/svg', 'radialGradient');
          grad.setAttribute('id', id);
          grad.setAttribute('cx', String(cx));
          grad.setAttribute('cy', String(cy));
          grad.setAttribute('r', String(rx));
          grad.setAttribute('gradientUnits', 'userSpaceOnUse');
          // SVG radial gradients are circles. Squashing the y axis about the
          // centre turns this one into an ellipse with semi-axes rx and ry,
          // so the tint stretches the full length AND width of the warned
          // area instead of sitting in a circle in the middle of it.
          if (Math.abs(ry - rx) > 0.5) {
            const k = ry / rx;
            grad.setAttribute(
              'gradientTransform',
              `translate(0 ${cy * (1 - k)}) scale(1 ${k})`
            );
          }
          // The middle two thirds stay near full strength so the colour
          // reads as a mass over the whole warning, and the fade is spent
          // in the outer third — a plateau, not a spotlight. Without it a
          // gradient this large would be visibly brighter at one point,
          // which looks like the warning is centred somewhere it isn't.
          const STOPS: [string, string][] = [
            ['0%', '0.5'],
            ['45%', '0.46'],
            ['70%', '0.32'],
            ['88%', '0.12'],
            ['100%', '0']
          ];
          for (const [offset, opacity] of STOPS) {
            const stop = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
            stop.setAttribute('offset', offset);
            stop.setAttribute('stop-color', color);
            stop.setAttribute('stop-opacity', opacity);
            grad.appendChild(stop);
          }
          cdefs!.appendChild(grad);

          el.setAttribute('fill', `url(#${id})`);
          // Blur scales with the cloud so a county-sized warning gets a
          // proportionally soft rim rather than the same 12px hairline
          // feather a small one gets. Capped so the biggest warnings do
          // not turn into an expensive full-screen blur.
          const softness = Math.round(Math.min(28, Math.max(10, Math.min(rx, ry) * 0.18)));
          el.style.filter = `blur(${softness}px)`;
        });
      }
    };

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
     *
     * NOTHING IS DRAWN OUTSIDE THE COVERAGE AREA. The weather feeds are wider
     * than this app is: a viewport near the border pulls back marine zones out
     * in the Atlantic, Mexican border counties, whole territories north of
     * 60°. Those were landing as icons and clouds on top of the grey — a
     * "Storm" chip floating over an area the map has just finished saying it
     * knows nothing about. The alert is still in `hazards` state, so a pin near
     * the line still reports it in its card; it just doesn't get drawn out
     * there.
     */
    const render = (alerts: HazardAlert[]) => {
      const placeable = alerts.filter(
        (a) =>
          Array.isArray(a.centroid) &&
          a.geometry &&
          isWithinCoverage(a.centroid[0], a.centroid[1])
      );

      const group = L.layerGroup([]);
      const present = new Set<AlertBadge>();
      // Diffuse glyph layers, wired to their patterns once the paths exist.
      const glyphTargets: { geo: L.GeoJSON; badge: 'heat' | 'smoke' | 'winter' | 'wind' | 'storm' }[] = [];
      /**
       * The diffuse cloud layers, paired with the colour their gradient uses.
       *
       * ONLY THE LAYER IS COLLECTED HERE — NOT ITS PATHS.
       *
       * Leaflet mints a Path's `_path` element in `onAdd`, which does not run
       * until the layer is on the MAP. Adding it to a LayerGroup that is itself
       * still detached creates nothing. The previous version walked `_path`
       * right here, always got undefined, and so every cloud silently kept its
       * flat `fillOpacity: 1` fill with no gradient and no blur — a hard opaque
       * slab instead of a soft cloud. The walk now happens after
       * `group.addTo(map)` below, where the elements actually exist.
       */
      const cloudLayers: { geo: L.GeoJSON; color: string }[] = [];

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
          // Exploded into one Feature per piece FIRST. A merged multi-zone
          // warning is a MultiPolygon, and Leaflet would draw all of its
          // scattered blocks into a single <path> sharing a single fill —
          // which means a single gradient spread across the gaps between
          // them, leaving the blocks themselves untinted. One path per
          // piece is what lets `paintClouds` size a gradient to each one.
          const pieces = explodeToFeatures(alert.geometry);
          const cloudGeo = L.geoJSON(pieces as any, {
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
          cloudLayers.push({ geo: cloudGeo, color });
          // The same area, filled with the tiled family glyph — thermometers
          // for heat — in the crisp glyph pane above the blur. Wired to its
          // pattern in <defs> below.
          const glyphGeo = L.geoJSON(pieces as any, {
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

      // Give the clouds their gradients now that their paths exist.
      drawnClouds = cloudLayers;
      paintClouds();

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

    /**
     * A zoom re-projects every path, so the cloud gradients — which are built
     * in the renderer's coordinate space — have to be measured again or the
     * soft centre of each cloud slides off the area it belongs to. Cheap: it
     * touches only the clouds already drawn, and never refetches.
     */
    const repaint = (): void => { if (drawnClouds.length) paintClouds(); };

    load();
    map.on('moveend zoomend', load);
    map.on('zoomend', repaint);

    return () => {
      cancelled = true;
      controller?.abort();
      if (debounce) clearTimeout(debounce);
      map.off('moveend zoomend', load);
      map.off('zoomend', repaint);
      drawnClouds = [];
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
  }, [isMapReady, isOfflineMode, showWarnings]);

  /* ------------------------------------------------------------------ */
  /* Active fires (WFIGS US perimeters + FireRadar CA points)           */
  /* ------------------------------------------------------------------ */
  /**
   * Fetch and draw the active-fire layer.
   *
   *   - On by default (`showFires`); when off we clear what is drawn and
   *     skip the fetch. The per-pin card reads from this same data
   *     independently of the toggle, so a hidden layer still surfaces
   *     "fire X km away" on the pin.
   *   - ONLY ACTIVE FIRES ARE HERE AT ALL. `/api/fires` drops incidents
   *     the agency has declared out, so this layer never has to decide
   *     what "active" means — it draws what it's given.
   *   - Every fire gets a flame, coloured by control state: orange when
   *     the agency reports it under control, red when it doesn't. A US
   *     perimeter and a Canadian point look the same, because to a
   *     camper they mean the same thing.
   *   - Perimeters (US, WFIGS) additionally get a thin stroke and faint
   *     fill of the burn footprint. The fire's actual size is in
   *     `sizeAcres`; we do not try to scale anything by acreage, because
   *     the user wants "there is a fire here", not "this fire is bigger
   *     than that fire".
   *   - Pane above the boundary fills, below the campsite pins. A flame
   *     marker on the map is worth more than the pin beneath it and has
   *     to be tappable to open its popup, same as a warning icon.
   *   - The fetch is debounced 250 ms, refetched on `moveend zoomend`
   *     when the new viewport is outside the loaded box. Cancel the
   *     in-flight request on the next move, the same requestId guard
   *     the warning and boundary effects use, so a slow older fetch
   *     does not overwrite a newer one (the "shows up then disappears"
   *     flicker).
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const clear = (): void => {
      if (!fireLayerRef.current) return;
      try { map.removeLayer(fireLayerRef.current); } catch { /* detached */ }
      fireLayerRef.current = null;
    };

    if (isOfflineMode) {
      clear();
      return;
    }

    if (!showFires) {
      // Layer off: clear what's drawn but leave the cached fetch in
      // place, so flipping the layer back on is instant.
      clear();
      return;
    }

    // One pane, above the boundary fills. The user can tap the perim /
    // point to read details, so the pane must be interactive.
    if (!map.getPane('firePane')) {
      map.createPane('firePane');
      const pane = map.getPane('firePane');
      if (pane) pane.style.zIndex = '560';
    }

    /** The raw viewport — what has to be COVERED by loaded data. */
    const viewBox = (): BoundingBox => ({
      minLat: map.getBounds().getSouth(),
      minLon: map.getBounds().getWest(),
      maxLat: map.getBounds().getNorth(),
      maxLon: map.getBounds().getEast()
    });

    /**
     * The area the drawn fires were fetched for, and a fingerprint of the
     * fires themselves.
     *
     * BOTH OF THESE EXIST TO STOP THE LAYER REDRAWING ON EVERY PAN.
     *
     * The box used to be compared padded-against-padded: the loaded box was
     * the padded viewport, and the next gesture's padded viewport was tested
     * against it. A padded box shifts whenever the viewport shifts, so that
     * test failed on essentially every pan — and each failure tore down every
     * flame marker, every perimeter and every popup binding and rebuilt them.
     * That is the flicker. The test is now the RAW viewport against the loaded
     * box, so the 60% pad `requestBoxFor` adds is real slack: you can pan more
     * than half a screen in any direction before anything is refetched.
     *
     * The fingerprint covers the rest. Crossing the edge of the loaded box
     * refetches, but the national fire feed almost always returns the same
     * incidents for the neighbouring box — and redrawing identical fires is
     * pure churn. If nothing about the set changed, the layer on the map is
     * left exactly as it is.
     */
    let loadedBox: BoundingBox | null = null;
    let drawnSignature: string | null = null;
    let requestId = 0;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let controller: AbortController | null = null;

    const renderFires = (fires: ActiveFire[]): void => {
      const group = L.layerGroup();
      for (const fire of fires) {
        /**
         * Nothing burns on the grey. The national feeds cover more ground
         * than this app does — Alaska, the territories, northern Mexico —
         * and a flame drawn out there is a claim about an area the map has
         * just said it doesn't cover.
         */
        if (!isWithinCoverage(fire.centroid.lat, fire.centroid.lon)) continue;
        /**
         * ONE BAD RECORD MUST NOT COST THE WHOLE LAYER.
         *
         * These loops build every fire into a group that is added to the map
         * at the end, so anything that throws mid-loop threw away every fire
         * already built — the entire layer vanished because a single feed
         * record was malformed. Skip the bad one and draw the rest.
         */
        try {
          const controlled = isUnderControl(fire);
          const colour = controlled ? FIRE_COLOR.controlled : FIRE_COLOR.running;
          const popup = buildFirePopupHtml(fire);

          // The burn footprint, when the feed gives us one. Drawn first so
          // the flame sits on top of its own perimeter.
          if (fire.kind === 'perimeter') {
            const poly = L.geoJSON(
              { type: 'Feature', geometry: fire.geometry, properties: {} } as GeoJSON.Feature,
              {
                pane: 'firePane',
                style: {
                  color: colour.fill,
                  weight: 1.5,
                  opacity: 0.85,
                  fillColor: colour.fill,
                  fillOpacity: 0.12,
                  // The polyline joins mustn't be smoothed — the data is
                  // a satellite-derived footprint and the joins are
                  // already the right shape.
                  lineJoin: 'miter'
                }
              }
            );
            poly.bindPopup(popup, { className: 'wl-fire-popup' });
            group.addLayer(poly);
          }

          // The flame. EVERY fire gets one, US and Canadian alike — a
          // perimeter smaller than a fingertip is invisible and untappable
          // without it, which is most perimeters at trip-planning zoom.
          const marker = L.marker([fire.centroid.lat, fire.centroid.lon], {
            pane: 'firePane',
            icon: L.divIcon({
              className: 'wl-fire-marker',
              html: buildFirePointHtml(controlled),
              iconSize: [26, 26],
              iconAnchor: [13, 13]
            })
          });
          marker.bindPopup(popup, { className: 'wl-fire-popup' });
          group.addLayer(marker);
        } catch { /* unusable geometry from the feed — draw the others */ }
      }
      // Swap in the new layer; the old one was already removed by `clear`.
      const previous = fireLayerRef.current;
      fireLayerRef.current = group.addTo(map);
      if (previous) {
        try { map.removeLayer(previous); } catch { /* detached */ }
      }
    };

    const run = async (): Promise<void> => {
      const view = viewBox();
      // Everything on screen is inside data we already hold. Nothing to do —
      // no fetch, and above all no redraw.
      if (loadedBox && boxContains(loadedBox, view)) return;

      const box = requestBoxFor(view, map.getZoom());
      const myId = ++requestId;
      controller?.abort();
      controller = new AbortController();

      const data = await fetchActiveFires(box, controller.signal);
      if (cancelled || myId !== requestId) return;
      // Only NOW is this area loaded. Marking it before the fetch meant a
      // failed or aborted request still counted as "we have this area", so
      // the layer stayed empty until the user panned somewhere new.
      loadedBox = box;

      const fires = data.features.map((f) => f.properties);
      // Identity plus the one property that changes how a fire is drawn.
      // Sorted, because feed ordering is not stable between requests and an
      // order-sensitive fingerprint would report a change on every fetch.
      const signature = fires
        .map((f) => `${f.id}:${isUnderControl(f) ? 'c' : 'r'}`)
        .sort()
        .join('|');
      if (signature === drawnSignature && fireLayerRef.current) return;
      drawnSignature = signature;
      renderFires(fires);
    };

    const schedule = (): void => {
      if (debounce) clearTimeout(debounce);
      // Same debounce as the boundary effect — 250 ms is short enough
      // to feel instant and long enough to merge a flurry of moveends
      // into a single fetch.
      debounce = setTimeout(() => { run().catch(() => undefined); }, 250);
    };

    map.on('moveend zoomend', schedule);
    // Initial fetch on (re-)enable.
    schedule();

    return () => {
      cancelled = true;
      controller?.abort();
      if (debounce) clearTimeout(debounce);
      map.off('moveend zoomend', schedule);
      clear();
    };
  }, [isMapReady, isOfflineMode, showFires]);

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
   * Icon for a pinned site: hollow or filled, with its dot row.
   *
   * Hazards lead the row. A heat warning or smoke over the spot changes
   * whether to go at all, which outranks anything about the spot itself.
   */
  const iconForId = useCallback(
    (id: string) =>
      buildCampsiteIcon(selectedIdRef.current === id, [
        ...hazardDots(badgesByIdRef.current.get(id) ?? []),
        ...(amenityDotsRef.current.get(id) ?? [])
      ]),
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

    (clusterViewRef.current ?? map).addLayer(cluster);
    clusterRef.current = cluster;
  }, [pinnedCampsites, isMapReady, onSelectCampsite, onOpenDetailModal, iconForId]);

  // Swap only the two icons that changed.
  useEffect(() => {
    const previousId = selectedIdRef.current;
    const nextId = selectedCampsite?.id ?? null;
    if (previousId === nextId) return;
    // Update the ref first: iconForId reads it, and both pins need the new state.
    selectedIdRef.current = nextId;
    if (previousId) {
      const marker = markersRef.current.get(previousId);
      marker?.setIcon(iconForId(previousId));
      marker?.setZIndexOffset(0);
    }
    if (nextId) {
      const marker = markersRef.current.get(nextId);
      marker?.setIcon(iconForId(nextId));
      // Leaflet stacks markers by latitude, so a selected pin's expanded
      // chips would otherwise slide under any pin north of it.
      marker?.setZIndexOffset(800);
    }
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
   * Set when the province on screen has no Crown land layer behind it.
   *
   * Drives both the status chip and the note under it. Held as one value so
   * the two can never disagree about whether the map is blank for a reason.
   */
  const dataGapNote = showBoundaries && !zoomTooFar
    ? landDataGap(viewJurisdiction?.isoCode)
    : null;

  const statusText = useCallback((): string => {
    if (!showBoundaries) return 'Land boundaries hidden';
    if (zoomTooFar) return 'Zoom in for land boundaries';
    if (isLoadingBoundaries) return 'Loading boundaries…';
    /**
     * A BLANK MAP MUST NEVER SAY "NOTHING HERE" WHEN IT MEANS "NO DATA".
     *
     * Only Alberta and Ontario publish a queryable layer of campable Crown
     * land. In British Columbia, Saskatchewan, Manitoba, Quebec and Atlantic
     * Canada this app draws nothing — and until now it captioned that with
     * "No mapped public land in view", which reads as a statement that there
     * is nowhere to camp in provinces that are mostly Crown land. Naming the
     * province and the gap turns a wrong answer into an honest one.
     */
    if (dataGapNote && boundaries.features.length === 0) {
      return `${viewJurisdiction?.name} — no Crown land data`;
    }
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
  }, [
    showBoundaries, zoomTooFar, isLoadingBoundaries, isOverviewTier,
    boundaries.features.length, viewJurisdiction, dataGapNote
  ]);

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

            {/*
              The blank-province note.

              Shown whenever the map has no Crown land layer for the province
              under the middle of the screen. It is deliberately not a
              collapsible legend row: the whole point is that a camper looking
              at an empty map in British Columbia reads WHY it is empty without
              tapping anything.
            */}
            {dataGapNote && boundaries.features.length === 0 && (
              <div className="px-3 pb-2 pt-0.5 border-t border-slate-700/60">
                <p className="text-[10px] leading-tight text-amber-300/90">
                  No Crown land layer for {viewJurisdiction?.name} yet — only
                  Alberta and Ontario publish one this app can read. A blank map
                  here means missing data, not missing public land.
                </p>
              </div>
            )}

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
          WHAT REPLACED THE WEATHER LEGEND.

          There used to be a colour key here: a swatch, an icon and a word per
          warning family, which asked the camper to look away from the map,
          learn a code, and carry it back. The pins carry it now — a coloured
          dot per warning sits over any spot a warning covers, and tapping the
          spot spells each one out in words.

          What a legend was still needed for is what is left: saying that the
          animated clouds are warnings at all, naming which kinds are on
          screen, and admitting to the ones that arrived with no geometry and
          so are not drawn anywhere. No colour key, no tappable rows.
        */}
        {(warningBadges.length > 0 || unmappableHazards > 0) && (
          <div className="bg-slate-900/92 backdrop-blur-md border border-amber-600/50 rounded-xl px-3 py-2 shadow-xl anim-in-up max-w-[15rem]">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span className="text-[11px] font-bold text-amber-100">
                {warningBadges.length > 0
                  ? `${warningBadges.map((b) => WARNING_LABEL[b]).join(', ')} in view`
                  : 'Warnings in view'}
              </span>
            </div>
            {unmappableHazards > 0 && (
              <p className="text-[9px] text-amber-300/80 leading-tight mt-1">
                {unmappableHazards} more came with no mapped area, so
                {unmappableHazards === 1 ? ' it is' : ' they are'} not drawn
                anywhere — tap a spot to read
                {unmappableHazards === 1 ? ' it' : ' them'}.
              </p>
            )}
            <p className="text-[9px] text-slate-500 leading-tight mt-1">
              Shaded, animated clouds are the area an agency warned about. A pin
              inside one carries a coloured dot per warning — tap it to read them.
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
            <label className="flex items-center justify-between px-2 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
              <span>Weather warnings</span>
              <input
                type="checkbox"
                checked={showWarnings}
                onChange={(e) => setShowWarnings(e.target.checked)}
                className="accent-emerald-500 w-3.5 h-3.5"
              />
            </label>
            <label className="flex items-center justify-between px-2 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
              <span>Active fires</span>
              <input
                type="checkbox"
                checked={showFires}
                onChange={(e) => setShowFires(e.target.checked)}
                className="accent-emerald-500 w-3.5 h-3.5"
              />
            </label>
            {/*
              The flame colours mean something, so they get a key. It only
              appears while the layer is on — a key to something that isn't
              drawn is just clutter. Colours come from FIRE_COLOR so the
              key can't drift away from the flames on the map.
            */}
            {showFires && (
              <div className="px-2 pb-1.5 -mt-0.5 flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-[9px] text-slate-400">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: FIRE_COLOR.running.fill }}
                  />
                  Not reported under control
                </span>
                <span className="flex items-center gap-1.5 text-[9px] text-slate-400">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: FIRE_COLOR.controlled.fill }}
                  />
                  Reported under control
                </span>
              </div>
            )}
            <label className="flex items-center justify-between px-2 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
              <span>State / province lines</span>
              <input
                type="checkbox"
                checked={showAdmin1}
                onChange={(e) => setShowAdmin1(e.target.checked)}
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
