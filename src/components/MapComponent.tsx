import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.vectorgrid';
import {
  AlertTriangle, Crosshair, Eye, Info, Layers, Loader2, MapPin,
  MousePointerClick, Navigation, Search, User as UserIcon, X
} from 'lucide-react';
import { UserMenu, AccountPanelBody } from './UserMenu';
import { MapPanel } from './ui/MapPanel';
import { FacilityPicker } from './FacilityPicker';
import { FacilityCard } from './FacilityCard';
import { rememberFacilityHandoff } from '../utils/facilityCheck';

import type {
  Campsite, CellCoverage, DestinationLand, FacilityKind, FacilityLookupState,
  FacilityNote,
  MapDestination, MapFacility, MapTileLayer, NearbyFacility, BeaconSpot, BackroadScan
} from '../types';

import { ScoutPathsLayer } from './ScoutPathsLayer';
import { SCOUT_PATHS_MIN_ZOOM } from '../config/coverage';

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
impor
t {
  fetchBackroads, backroadRequestBox, backroadBoxCovers
} from '../services/backroadService';
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

/** 1x1 transparent GIF, shown where no offline tile has been cached. */
const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAA
BAAEAAAIBRAA7';

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
 * Zoom level the al
ways-there backdrop is drawn from.
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
 * How soft the edge of a weather cloud is, in screen pixels.
 *
 * Enough that no straight survey line from a forecast region survives, not so
 * much that the area stops having a shape. A camper has to be able to tell
 * roughly where the smoke is and must NOT be able to point at the line where
 * it stops, because there isn't one.
 */
const CLOUD_BLUR_PX = 11;

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
 * the whole world, so zooming out on 
a wide screen quietly pulled in
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
 * T
WO STATES, AND THE WHOLE INTERFACE HANGS OFF THE DIFFERENCE.
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
/**
 * Resting: colour only, no words. The pin is the label.
 *
 * Only a live hazard breathes. Everything else — including a recorded "no
 * water" — is bad news that already happened and holds still, so the one dot
 * that is moving on a screenful of pins is always something burning, blowing
 * or freezing right now.
 */
/**
 * THEY GO ROUND THE PIN, NOT ABOVE IT — AND EVERY FACT GETS ONE.
 *
 * A row above the marker could only ever hold four or five dots before it was
 * wider than the pin and colliding with the row over the next spot along, so
 * everything past the fourth fact became a grey "+n" that said nothing. There
 * is no cap now: a spot with nine recorded facts shows nine beads, because the
 * count itself is information — a pin wearing a full ring is a well-equipped
 * spot at a glance.
 *
 * The ring GROWS to fit rather than the beads crowding: at the base radius the
 * circumference seats about twelve dots with air between them, and past that
 * the radius is widened so the gap stays constant however many there are.
 *
 * Placed with a translate rathe
r than a rotate so the dot itself is never
 * rotated — and on an outer slot rather than on the dot, because the urgent
 * dot's breathing is a `transform: scale` and would otherwise wipe out its
 * position.
 */
const RING_RADIUS_PX = 19;
/** Dot plus the gap after it — the arc one bead is allowed to occupy. */
const RING_BEAD_PITCH_PX = 10;

const collapsedDotRing = (dots: MarkerDot[]): string => {
  if (!dots.length) return '';
  // Widen the ring rather than let beads touch once the circle is full.
  const radius = Math.max(RING_RADIUS_PX, (dots.length * RING_BEAD_PITCH_PX) / (2 * Math.PI));
  const step = 360 / dots.length;
  const cells = dots
    .map((d, i) => {
      // Clockwise from the top, so the first fact — always the most urgent
      // one, since hazards lead the list — sits at twelve o'clock.
      const angle = ((-90 + i * step) * Math.PI) / 180;
      const x = (Math.cos(angle) * radius).toFixed(1);
      const y = (Math.sin(angle) * radius).toFixed(1);
      return (
        `<i class="wl-dot-slot" style="transform:translate(${x}px,${y}px)">` +
        `<i class="wl-dot${d.urgent ? ' wl-dot-urgent' : ''}` +
        `${d.hollow ? ' wl-dot-hollow' : ''}" ` +
        `style="--wl-dot-color:${d.color}"></i></i>`
      );
    })
    .join('');

  return `<div class="wl-dots">${cells}</div>`;
};

/**
 * Escape text before it goes into a divIcon's HTML.
 *
 * A chip's label carries an OpenStreetMap facility name and a campsite's
 * recorded facts, so the worst realistic case is a malformed upstream record —
 * but it lands in innerHTML, so it gets escaped.
 */
const escapeHtml = (s: string): string => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/**
 * The outline of a shape, as Leaflet wants it: the biggest ring, `[lat, lon]`.
 *
 * A cloud piece is a MultiPolygon — several parcels the grouping pulled
 * together — and the tracker follows the largest of them. Not 
all of them:
 * a dot that teleported between blocks would read as several separate things
 * being pointed at rather than one area being outlined. Holes are ignored for
 * the same reason; the softened cloud fills them in anyway.
 */
const outerRing = (shape: GeoJSON.Feature): [number, number][] => {
  const geometry = shape.geometry as { type?: string; coordinates?: unknown };
  const polygons: [number, number][][][] =
    geometry?.type === 'MultiPolygon'
      ? (geometry.coordinates as [number, number][][][])
      : geometry?.type === 'Polygon'
        ? [geometry.coordinates as [number, number][][]]
        : [];

  let best: [number, number][] = [];
  let bestArea = -1;
  polygons.forEach((rings) => {
    const ring = rings?.[0];
    if (!Array.isArray(ring) || ring.length < 4) return;
    // Shoelace, in square degrees. Only ever compared against itself.
    let twice = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      twice += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    const area = Math.abs(twice) / 2;
    if (area > bestArea) { bestArea = area; best = ring; }
  });

  // GeoJSON counts [lon, lat]; everything Leaflet takes is the other way round.
  return best.map(([lon, lat]) => [lat, lon] as [number, number]);
};

/**
 * Tapped: the same dots, each grown into the fact it stood for.
 *
 * The chip is short — a glyph and two or three words — and the whole hedged
 * sentence rides along in `title`, so the caveats are a press away without a
 * paragraph lying across the map.
 *
 * A chip carrying a facility, or an action, is a button rather than a label —
 * it is somewhere you can go, so it opts back into pointer events and carries
 * the id for the delegated click handler.
 *
 * EVERY CHIP POPS, AND EACH ONE POPS EXACTLY ONCE.
 *
 * The row is rebuilt every time a lookup lands — the tap, then the fires,
 * then the weather, then whatever OpenStreetMap has up the road — so "animate
 * the row" and "animate
 nothing" are both wrong: the first restarts chips
 * that are already sitting there (popcorn), the second means the answers that
 * arrive after the tap simply blink into existence.
 *
 * So the animation is decided per chip, by whether this pin has shown that
 * chip before. `animateKeys` is that set of first-timers, and the stagger is
 * counted across them alone, which is why opening a pin plays the whole stack
 * in sequence while a toilet found two seconds later pops on its own.
 *
 * Chips that have already arrived carry no animation class at all, so the
 * next rebuild leaves them exactly where they are.
 */
/** The beat between one chip landing and the next, in ms. */
const CHIP_STAGGER_MS = 55;
/**
 * Everything waits this long before starting.
 *
 * Without it the first chip is on screen in the frame the pin opens, which is
 * the "some of them are just there" complaint: the stack has to start from
 * nothing for the sequence to read as a sequence.
 */
const CHIP_LEAD_MS = 70;

/**
 * Everything about a chip that is visible, as one string.
 *
 * Compared before a chip is touched, so a lookup landing with the same answer
 * leaves the existing element — and any pop it is halfway through — alone.
 */
const chipSignature = (d: MarkerDot): string => [
  d.color, d.label, d.full ?? '', d.glyph, d.tone,
  d.hollow ? 'h' : '', d.action ?? '', d.badge ?? '', d.facility?.id ?? ''
].join('\u0001');

/**
 * EVERY CHIP IS A BUTTON, AND EVERY CHIP LOOKS LIKE ONE.
 *
 * There used to be two kinds: a facility or the fire count, which were
 * tappable and wore an arrow, and everything else, which was a label that
 * swallowed nothing. That teaches the wrong lesson — a camper who has learned
 * that most chips do nothing stops trying the ones that do.
 *
 * So all of them take taps, and the mark on the right says what kind of answer
 * to expect:
 *
 *   ›   takes the camera to the thing the chip is talking about — the warning
 *       area, the parcel, the track in, the 
fires — and brings it back.
 *   …   has more to say than fits, and unfurls into the whole hedged sentence
 *       in place.
 *
 * That second one matters more than it looks. The caveats — that a signal
 * estimate is a distance to a mast with the terrain ignored, that a recorded
 * "no water" is one camper's visit — lived in the `title` attribute, which on
 * a phone means nowhere at all.
 */
const chipHtml = (d: MarkerDot, fresh: boolean, delay: number): string => {
  const go = d.facility;
  const travels = Boolean(d.action) || Boolean(go);
  const full = d.full ?? d.label;
  return (
    `<span class="wl-chip${d.tone === 'bad' ? ' wl-chip-bad' : ''}` +
    `${travels ? ' wl-chip-go' : ''}` +
    `${d.action === 'directions' ? ' wl-chip-nav' : ''}` +
    `${fresh ? ' wl-chip-in' : ''}" ` +
    `data-key="${escapeHtml(d.key)}" data-sig="${escapeHtml(chipSignature(d))}" ` +
    `data-label="${escapeHtml(d.label)}" data-full="${escapeHtml(full)}" ` +
    `${go ? `data-facility="${escapeHtml(go.id)}" ` : ''}` +
    `${d.action ? `data-action="${d.action}" ` : ''}` +
    `${d.badge ? `data-badge="${escapeHtml(d.badge)}" ` : ''}` +
    `role="button" tabindex="0" ` +
    `title="${escapeHtml(full)}" aria-label="${escapeHtml(full)}" ` +
    `style="--wl-chip-color:${d.color}` +
    `${fresh ? `;animation-delay:${delay}ms` : ''}">` +
    `<i class="wl-chip-dot${d.hollow ? ' wl-chip-dot-hollow' : ''}"></i>` +
    `<span class="wl-chip-glyph" aria-hidden="true">${d.glyph}</span>` +
    `<span class="wl-chip-text">${escapeHtml(d.label)}</span>` +
    `<span class="wl-chip-arrow" aria-hidden="true">${travels ? '›' : '…'}</span>` +
    `</span>`
  );
};

/**
 * When each arriving chip pops, counted from the BOTTOM of the stack.
 *
 * The row is a column anchored above the pin, so the LAST chip in DOM order
 * sits nearest the pin and the first sits highest. Staggering in DOM order
 * therefore ran the wave downwards, from the sky into the pin, which reads as
 * falling. Stac
king is the other way round: the chip nearest the pin lands
 * first and each one after it piles on top.
 *
 * Returned as a map rather than computed inline because `expandedDotRow` and
 * `patchChipRow` both need the same answer, and two copies of a rule about
 * timing drift into two slightly different animations.
 */
const chipDelays = (dots: MarkerDot[], animateKeys: Set<string>): Map<string, number> => {
  const freshInOrder = dots.filter((d) => animateKeys.has(d.key));
  const delays = new Map<string, number>();

  freshInOrder.forEach((d, i) => {
    // Reverse the index: the last fresh chip (nearest the pin) goes first.
    const fromBottom = freshInOrder.length - 1 - i;
    delays.set(d.key, CHIP_LEAD_MS + fromBottom * CHIP_STAGGER_MS);
  });

  return delays;
};

/** The chips alone, with no row around them. The peek builds its own row. */
const chipsHtml = (dots: MarkerDot[], animateKeys: Set<string>): string => {
  const delays = chipDelays(dots, animateKeys);
  return dots
    .map((d) => chipHtml(d, animateKeys.has(d.key), delays.get(d.key) ?? 0))
    .join('');
};

const expandedDotRow = (dots: MarkerDot[], animateKeys: Set<string>): string =>
  `<div class="wl-chips">${chipsHtml(dots, animateKeys)}</div>`;

/**
 * Add the chips that are new, leave the ones already there completely alone.
 *
 * THIS IS WHY THE PIN NO LONGER FLICKERS. Leaflet's own way to change a
 * marker is `setIcon`, which throws the marker's whole DOM away and builds it
 * again — the pin, the buttons and every chip. A pin answers in four or five
 * instalments (the tap, the fires, the weather, the facilities, the road), so
 * that was four or five full rebuilds in a couple of seconds: the pin blinked
 * each time, and any chip mid-pop was destroyed and replaced by a finished
 * one, which is exactly "some of them just appear".
 *
 * So updates are patched into the existing row instead, keyed by chip. A chip
 * whose wording has not changed keeps its element, its animation and its

 * place; a chip that has gone is removed; a chip that is new is built with
 * the pop on it and slotted into position. Nothing else in the marker is
 * touched, so the pin itself never redraws.
 *
 * Returns false if the marker is not on screen (clustered away, or not yet
 * added), in which case the caller falls back to rebuilding the icon.
 */
/**
 * Measure, change, then slide whatever moved into its new place.
 *
 * The stack is anchored under the pin and grows upwards, so a chip arriving
 * anywhere in it shoves every chip above it up by its own height — instantly,
 * because that is a layout change and layout does not animate. Four lookups
 * landing meant four of those jolts while the camper was reading.
 *
 * FLIP: note where each chip was, let the change happen, then put each chip
 * back where it started with a transform and release it on the next frame, so
 * it travels to its new home on the same curve everything else in the app uses.
 * A chip halfway through its own arrival pop is left alone — its animation owns
 * the transform, and it has nowhere to slide from anyway.
 */
const flipRow = (row: Element, mutate: () => void): void => {
  const before = new Map<HTMLElement, number>();
  row.querySelectorAll<HTMLElement>(':scope > .wl-chip').forEach((el) => {
    before.set(el, el.getBoundingClientRect().top);
  });

  mutate();

  before.forEach((top, el) => {
    if (!el.isConnected) return;
    const dy = top - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) return;
    el.style.transition = 'none';
    el.style.transform = `translateY(${dy}px)`;
    // Two frames: the first commits the offset, the second releases it. One is
    // not enough — the browser coalesces both writes and nothing moves.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transition = 'transform var(--dur-base) var(--ease-moook)';
        el.style.transform = '';
      });
    });
  });
};

const patchChipRow = (
  root: HTMLEle
ment | null | undefined,
  dots: MarkerDot[],
  animateKeys: Set<string>
): boolean => {
  const wrap = root?.firstElementChild;
  if (!wrap) return false;

  let row = wrap.querySelector(':scope > .wl-chips');
  const existed = Boolean(row);
  if (!row) {
    if (!dots.length) return true;
    row = document.createElement('div');
    row.className = 'wl-chips';
    wrap.insertBefore(row, wrap.firstChild);
  }
  const target = row;

  const rebuild = (): void => {
    const existing = new Map<string, Element>();
    target.querySelectorAll(':scope > .wl-chip').forEach((el) => {
      const key = el.getAttribute('data-key');
      if (key) existing.set(key, el);
    });

    const wanted = new Set<string>();
    const delays = chipDelays(dots, animateKeys);
    let placed: Element | null = null;

    for (const d of dots) {
      wanted.add(d.key);
      const fresh = animateKeys.has(d.key);
      const delay = fresh ? delays.get(d.key) ?? CHIP_LEAD_MS : 0;
      let node = existing.get(d.key) ?? null;

      if (!node || fresh || node.getAttribute('data-sig') !== chipSignature(d)) {
        const holder = document.createElement('template');
        holder.innerHTML = chipHtml(d, fresh, delay);
        const next = holder.content.firstElementChild;
        if (!next) continue;
        if (node) node.replaceWith(next);
        node = next;
      }

      // Only move a chip that is genuinely out of order: re-inserting an
      // element restarts its animation, which is the popcorn all over again.
      const slot = placed ? placed.nextElementSibling : target.firstElementChild;
      if (node !== slot) target.insertBefore(node, slot);
      placed = node;
    }

    existing.forEach((el, key) => { if (!wanted.has(key)) el.remove(); });
  };

  // A row being built from nothing has nothing to slide — that case is the
  // whole stack arriving, which is the pop.
  if (existed) flipRow(target, rebuild);
  else rebuild();

  if (!dots.length) target.remove();
  return tru
e;
};

/**
 * Take a stack away, top chip first, and say how long that will take.
 *
 * The wave came up from the pin outwards, so it leaves from the loose end
 * inwards: the top chip goes first and the one resting on the pin goes last.
 * Dismantling it in the order it was built looks like the bottom being pulled
 * out from under the rest.
 */
const retractChips = (row: Element): number => {
  const chips = Array.from(row.querySelectorAll<HTMLElement>(':scope > .wl-chip'));

  chips.forEach((chip, i) => {
    chip.classList.remove('wl-chip-in');
    chip.style.animationDelay = `${i * PEEK_OUT_STAGGER_MS}ms`;
    chip.classList.add('wl-chip-out');
  });

  return chips.length * PEEK_OUT_STAGGER_MS + PEEK_OUT_DURATION_MS;
};

/* ------------------------------------------------------------------ */
/* The press-and-hold peek                                             */
/* ------------------------------------------------------------------ */

/**
 * Hold a pin down and its chips rise; let go and they fall away again.
 *
 * ---------------------------------------------------------------------------
 * WHY A PEEK RATHER THAN JUST TAPPING THE PIN
 * ---------------------------------------------------------------------------
 *
 * Tapping selects a spot: it flies the camera, opens the sheet, fetches
 * weather, fires, signal and facilities, and closes whatever was open before.
 * That is the right weight for "I am considering this place" and far too much
 * for "what is that one?" — which, three pins into a scan of a valley, is the
 * question you actually have. The peek answers it without moving the map or
 * disturbing the pin you already had open.
 *
 * ---------------------------------------------------------------------------
 * IT ONLY EVER SHOWS WHAT IS ALREADY KNOWN
 * ---------------------------------------------------------------------------
 *
 * The peek fires no requests. It draws the dots the pin is ALREADY wearing —
 * hazards and the spot's own recorded
 facilities — grown into their words.
 * That is deliberate twice over: a hold has to answer instantly to feel like
 * a peek rather than a load, and firing weather and OSM lookups at every pin
 * somebody rests a thumb on would hammer four upstream services for a glance.
 *
 * So a peeked pin shows less than a tapped one, and nothing it shows is a
 * guess: it is the same set of facts, in the same words, that the ring of dots
 * was already standing for.
 */

/** How long a press has to last before it counts as a hold, in ms. */
const PEEK_HOLD_MS = 320;

/** Movement that turns a hold into a map drag, in px. */
const PEEK_SLOP_PX = 10;

/** The beat between one chip leaving and the next, in ms. */
const PEEK_OUT_STAGGER_MS = 34;

/** Roughly the duration of --dur-tap, for cleaning up after the retract. */
const PEEK_OUT_DURATION_MS = 160;

/**
 * Draw the peek stack into a pin that is not open.
 *
 * Built as its own row rather than by reusing `patchChipRow`, because that
 * function is the OPEN pin's incremental updater and shares its memory of
 * which chips have already popped. A peek must always play from nothing, and
 * must never teach the open pin's memory that a chip has been seen.
 */
const openPeek = (wrap: Element, dots: MarkerDot[]): boolean => {
  if (!dots.length) return false;

  // A peek from a moment ago may still be retracting. Take it out at once and
  // start over, rather than refusing — holding a pin again straight away and
  // getting nothing feels like the gesture is broken.
  wrap.querySelector(':scope > .wl-chips-peek')?.remove();

  // A row that is not a peek belongs to an open pin, and that one has real
  // lookups behind it. Never replace it.
  if (wrap.querySelector(':scope > .wl-chips')) return false;

  const row = document.createElement('div');
  row.className = 'wl-chips wl-chips-peek';
  // Every chip counts as fresh: a peek always plays the whole stack from
  // nothing, because each one is its own separate glance.
  row.inn
erHTML = chipsHtml(dots, new Set(dots.map((d) => d.key)));

  wrap.insertBefore(row, wrap.firstChild);
  return true;
};

/**
 * Take the peek away, top chip first.
 *
 * The stack came up from the pin outwards, so it goes away from the loose end
 * inwards — the top chip leaves first and the one resting on the pin leaves
 * last. Dismantling it in the same order it was built would look like the
 * bottom being pulled out from under the rest.
 */
const closePeek = (wrap: Element | null | undefined): void => {
  const row = wrap?.querySelector(':scope > .wl-chips-peek');
  if (!row) return;

  // Removed on a timer rather than on animationend: a chip whose animation
  // never fires — reduced motion, a backgrounded tab, an element detached
  // mid-flight — would otherwise leave the row on the map for ever.
  window.setTimeout(() => row.remove(), retractChips(row));
};

/**
 * The same exit, for the OPEN pin's real stack.
 *
 * Closing a spot used to swap the whole icon on the spot, so the stack of
 * answers vanished between one frame and the next while the hold-to-peek
 * stack — the same chips, in the same column — always wound itself down
 * politely. `onDone` is what actually rebuilds the pin, and it runs after the
 * last chip has gone rather than on top of it.
 */
const retractChipRow = (
  root: HTMLElement | null | undefined,
  onDone: () => void
): void => {
  const row = root?.firstElementChild?.querySelector(':scope > .wl-chips');
  if (!row || !row.querySelector(':scope > .wl-chip')) { onDone(); return; }
  window.setTimeout(() => { row.remove(); onDone(); }, retractChips(row));
};

/* ------------------------------------------------------------------ */
/* One wave, not four                                                  */
/* ------------------------------------------------------------------ */
/**
 * THE OPEN PIN'S STACK ARRIVES THE WAY THE HELD PIN'S DOES: ALL AT ONCE.
 *
 * A pin answers in instalments — the tap, then the fires, then the weather a
nd
 * the drive, then whatever OpenStreetMap has up the road — and each instalment
 * used to redraw the row the moment it landed. Every chip still popped, but the
 * popping was spread over four separate arrivals a second or two apart, which
 * reads as things dribbling in rather than as a stack being built. The
 * press-and-hold peek looks better for one reason only: it has all its
 * information at the moment it opens, so it plays as a single wave.
 *
 * So arrivals are collected and applied together. A change waits `WAIT` for
 * the next one to join it, and the whole batch goes in as one wave — the same
 * bottom-up stagger the peek plays. `MAX` is the backstop: a slow feed
 * trickling in forever must not hold the answers off the screen 

... [Content truncated]