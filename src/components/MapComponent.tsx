import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.vectorgrid';
import {
  Crosshair, Eye, Info, Layers, Loader2, MousePointerClick, Navigation, X
} from 'lucide-react';

import type {
  Campsite, CellCoverage, DestinationLand, MapDestination, MapTileLayer, NearbyFacility,
  BeaconSpot
} from '../types';
import { getCachedTile } from '../services/offlineStorage';
import { pointInGeometry } from '../utils/geo';
import { hazardReportStyle, reportStanding } from '../config/hazardReports';
import { beaconTierStyle } from '../config/beacon';
import { fetchHazardsNear, fetchBeaconSpotsNear, HazardRecord } from '../services/dataService';
import {
  fetchBoundaries, requestBoxFor, overviewBoxFor, boxContains, BOUNDARY_STYLES,
  EMPTY_BOUNDARIES, BoundaryCollection, BoundaryConfidence, BoundaryFeature,
  BoundaryDetail, EdgeAccuracy
} from '../services/boundaryService';
import {
  fetchActiveFires, findFiresNear, boxAround, isUnderControl, FIRE_ALERT_RADIUS_KM, ActiveFire
} from '../services/fireService';
import { fetchAdmin1, Admin1, primeAdmin1 } from '../services/admin1Service';
import { isOnLand, primeLandMask } from '../services/landService';
import {
  buildFuzzRings, ringBudget, edgeBlurPx, UNCERTAINTY_LABEL, shouldSimplify
} from '../utils/fuzzyBoundary';
import {
  AlertBadge, LocalizedKind, BADGE_COLOR, badgesForPoint, alertBadge, WARNING_LABEL,
  localizedPinHtml, centroidBadgeHtml, isGeneralized, mergeAreas,
  dissolveKey, dissolveSegments, dissolvedFill
} from '../utils/alertOverlay';
import {
  MarkerDot, amenityDots, conditionDots, facilityDots, fireDots, hazardDots,
  FACILITY_COLOR
} from '../utils/amenityDots';
import {
  fetchNearbyFacilities, fetchNearestDriveableRoad, ROAD_RADIUS_KM,
  FACILITY_GLYPH, FACILITY_LABEL, FACILITY_RADIUS_KM
} from '../services/nearbyAmenityService';
import { calculateRoute, RouteResult } from '../services/routingService';
import { directionsAppName, openDirections } from '../utils/handoff';
import {
  BoundingBox, MAP_VIEW_BBOX, COVERAGE_OUTLINE, WORLD_RING, VIEW_RING,
  BOUNDARY_MIN_ZOOM, BOUNDARY_OVERVIEW_MIN_ZOOM, overviewMinAreaSqKm,
  COVERAGE_LABEL, isWithinCoverage
} from '../config/coverage';
import {
  fetchAreaAlerts, HazardAlert, HAZARD_STYLE, sortAlerts, WeatherSnapshot
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
 * Placed with a translate rather than a rotate so the dot itself is never
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
 * the row" and "animate nothing" are both wrong: the first restarts chips
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
  d.hollow ? 'h' : '', d.action ?? '', d.facility?.id ?? ''
].join('\u0001');

const chipHtml = (d: MarkerDot, fresh: boolean, delay: number): string => {
  const go = d.facility;
  const tappable = Boolean(go) || Boolean(d.action);
  const full = d.full ?? d.label;
  return (
    `<span class="wl-chip${d.tone === 'bad' ? ' wl-chip-bad' : ''}` +
    `${tappable ? ' wl-chip-go' : ''}${fresh ? ' wl-chip-in' : ''}" ` +
    `data-key="${escapeHtml(d.key)}" data-sig="${escapeHtml(chipSignature(d))}" ` +
    `${go ? `data-facility="${escapeHtml(go.id)}" ` : ''}` +
    `${d.action ? `data-action="${d.action}" ` : ''}` +
    `${tappable ? 'role="button" tabindex="0" ' : ''}` +
    `title="${escapeHtml(full)}" aria-label="${escapeHtml(full)}" ` +
    `style="--wl-chip-color:${d.color}` +
    `${fresh ? `;animation-delay:${delay}ms` : ''}">` +
    `<i class="wl-chip-dot${d.hollow ? ' wl-chip-dot-hollow' : ''}"></i>` +
    `<span class="wl-chip-glyph" aria-hidden="true">${d.glyph}</span>` +
    `${escapeHtml(d.label)}` +
    `${tappable ? '<span class="wl-chip-arrow" aria-hidden="true">›</span>' : ''}</span>`
  );
};

const expandedDotRow = (dots: MarkerDot[], animateKeys: Set<string>): string => {
  let arriving = 0;
  const chips = dots
    .map((d) => {
      const fresh = animateKeys.has(d.key);
      return chipHtml(d, fresh, fresh ? CHIP_LEAD_MS + arriving++ * CHIP_STAGGER_MS : 0);
    })
    .join('');
  return `<div class="wl-chips">${chips}</div>`;
};

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
const patchChipRow = (
  root: HTMLElement | null | undefined,
  dots: MarkerDot[],
  animateKeys: Set<string>
): boolean => {
  const wrap = root?.firstElementChild;
  if (!wrap) return false;

  let row = wrap.querySelector(':scope > .wl-chips');
  if (!row) {
    if (!dots.length) return true;
    row = document.createElement('div');
    row.className = 'wl-chips';
    wrap.insertBefore(row, wrap.firstChild);
  }

  const existing = new Map<string, Element>();
  row.querySelectorAll(':scope > .wl-chip').forEach((el) => {
    const key = el.getAttribute('data-key');
    if (key) existing.set(key, el);
  });

  const wanted = new Set<string>();
  let arriving = 0;
  let placed: Element | null = null;

  for (const d of dots) {
    wanted.add(d.key);
    const fresh = animateKeys.has(d.key);
    const delay = fresh ? CHIP_LEAD_MS + arriving++ * CHIP_STAGGER_MS : 0;
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
    const slot = placed ? placed.nextElementSibling : row.firstElementChild;
    if (node !== slot) row.insertBefore(node, slot);
    placed = node;
  }

  existing.forEach((el, key) => { if (!wanted.has(key)) el.remove(); });
  if (!dots.length) row.remove();
  return true;
};

/**
 * Which of these chips this pin has never shown, marking them shown as it
 * goes. Mutates deliberately: the caller's set IS the pin's memory, and it is
 * emptied when the pin closes so opening it again replays the whole stack.
 */
const freshChipKeys = (shown: Set<string>, dots: MarkerDot[]): Set<string> => {
  const fresh = new Set<string>();
  for (const d of dots) {
    if (shown.has(d.key)) continue;
    fresh.add(d.key);
    shown.add(d.key);
  }
  return fresh;
};

const NAV_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px">' +
  '<path d="M3 11 22 2l-9 19-2-8-8-2z"/></svg>';

const INFO_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" style="width:12px;height:12px">' +
  '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.2"/></svg>';

const PLUS_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
  'stroke-linecap="round" style="width:12px;height:12px">' +
  '<path d="M12 5v14M5 12h14"/></svg>';

const CLOSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
  'stroke-linecap="round" style="width:12px;height:12px">' +
  '<path d="M18 6 6 18M6 6l12 12"/></svg>';

/** "Google Maps" or "Apple Maps" — the phone's own app, named on the button. */
const DIRECTIONS_LABEL = directionsAppName();

/**
 * The two things you can DO with the open pin, directly under it.
 *
 * They used to live in the footer of a panel over the bottom half of the
 * screen. Under the pin they are where the thumb already is and, more to the
 * point, they are attached to the thing they act on — tapping "take me there"
 * three pins into a browse can no longer mean the pin you were last reading
 * about rather than the one you are looking at.
 */
const pinActionsRow = (
  label: string,
  secondary?: { action: 'add' | 'details'; label: string; glyph: string }
): string =>
  `<div class="wl-pin-actions">` +
  `<span class="wl-pin-action wl-pin-action-go" data-action="directions" ` +
  `role="button" tabindex="0" title="Open in ${escapeHtml(label)}" ` +
  `aria-label="Open in ${escapeHtml(label)}">${NAV_SVG}Go</span>` +
  (secondary
    ? `<span class="wl-pin-action" data-action="${secondary.action}" ` +
      `role="button" tabindex="0" title="${escapeHtml(secondary.label)}" ` +
      `aria-label="${escapeHtml(secondary.label)}">${secondary.glyph}</span>`
    : '') +
  `<span class="wl-pin-action wl-pin-action-close" data-action="close" ` +
  `role="button" tabindex="0" aria-label="Close this spot" title="Close">` +
  `${CLOSE_SVG}</span>` +
  `</div>`;

const buildCampsiteIcon = (
  isSelected: boolean,
  dots: MarkerDot[] = [],
  directionsLabel?: string,
  /** Chip keys this pin has not shown yet. See `refreshIcon`. */
  animateKeys: Set<string> = new Set()
): L.DivIcon => {
  const row = dots.length
    ? (isSelected ? expandedDotRow(dots, animateKeys) : collapsedDotRing(dots))
    : '';

  return L.divIcon({
    className: 'custom-campsite-marker',
    html:
      `<div class="wl-pin-wrap${isSelected ? ' wl-pin-wrap-on' : ''}">` +
      row +
      `<div class="wl-pin${isSelected ? ' wl-pin-on' : ''}">${TENT_SVG}</div>` +
      `${isSelected && directionsLabel
        ? pinActionsRow(directionsLabel, {
          action: 'details', label: 'Everything recorded about this spot', glyph: INFO_SVG
        })
        : ''}` +
      `</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });
};

/**
 * A camper's hazard report.
 *
 * A TEARDROP PIN, the same shape an official fire or flood warning wears,
 * because it is the same shape of fact: something is wrong AT THIS SPOT. A
 * washout, a weak bridge and a downed tree all read as one dark-grey barricade
 * pin — they are the same decision for a driver, and the card names the actual
 * kind when you tap it. Fire and flooding keep the fire and flood colours, so a
 * camper's flood report and an agency's flood warning look alike on purpose.
 *
 * The look matches an official pin; the behaviour is where the honesty lives.
 * This marker opens a card that spells out it is one person's report and not
 * verified, and a report several people have confirmed gets a pale ring.
 */
const buildHazardReportIcon = (record: HazardRecord): L.DivIcon => {
  const style = hazardReportStyle(record.kind);
  const confirmed = reportStanding(record.confirms, record.disputes) === 'confirmed';
  // Slightly smaller than an official warning pin: a camper report is one
  // person's account and should not shout over an agency's.
  const size = style.prominent ? 32 : 27;
  const height = Math.round((size * 44) / 36);

  return L.divIcon({
    className: 'hazard-report-marker',
    html: localizedPinHtml({ kind: style.pin, size, ring: confirmed }),
    iconSize: [size, height],
    // The tip of the teardrop sits on the reported point.
    iconAnchor: [size / 2, height]
  });
};

/**
 * A Beacon spot.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LOOKS DELIBERATELY UNLIKE A CAMPSITE PIN
 * ---------------------------------------------------------------------------
 *
 * A campsite pin means somebody put a campsite there. A Beacon spot means the
 * app read some map data and thought "maybe". Drawing the two the same way
 * would let a guess borrow a real site's authority at a glance, from across
 * the map, before any text has been read.
 *
 * So this is a hollow ring, not a filled tent pin: an outline reads as
 * provisional where a solid shape reads as a fact. The grey `lead` ring is
 * dashed on top of that, because grey means nobody has ever been there, and
 * that is the one state a camper most needs to catch without opening anything.
 * A confirmed spot earns a solid ring and a filled centre — and it can only
 * earn those from other campers.
 */
const buildBeaconIcon = (spot: BeaconSpot): L.DivIcon => {
  const style = beaconTierStyle(spot.tier);
  const size = 26;
  const isLead = spot.tier === 'lead';

  const html =
    `<div style="width:${size}px;height:${size}px;border-radius:9999px;` +
    `border:2px ${isLead ? 'dashed' : 'solid'} ${style.ring};` +
    `background:${style.colorSoft};display:flex;align-items:center;` +
    `justify-content:center;box-sizing:border-box;">` +
    `<div style="width:${isLead ? 5 : 9}px;height:${isLead ? 5 : 9}px;` +
    `border-radius:9999px;background:${style.color};"></div></div>`;

  return L.divIcon({
    className: 'beacon-spot-marker',
    html,
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
 *
 * IT CARRIES THE SAME ROW OF FACTS A SUBMITTED SPOT DOES. Tapping bare ground
 * is a camper asking "what is it like here?", and the answer used to be split:
 * warnings and fires were painted across the map as separate features, and the
 * pin itself said nothing. Now whatever is true of this patch of ground —
 * warnings over it, a fire burning near it, a toilet up the road — is stacked
 * above the pin in words, the same as it is above a spot somebody submitted.
 */
const buildDestinationIcon = (
  dots: MarkerDot[] = [],
  directionsLabel?: string,
  addLabel?: string,
  animateKeys: Set<string> = new Set()
): L.DivIcon =>
  L.divIcon({
    className: 'destination-marker',
    html: `
      <div class="relative flex items-end justify-center anim-pin-drop">
        ${dots.length ? expandedDotRow(dots, animateKeys) : ''}
        ${directionsLabel
          ? pinActionsRow(
            directionsLabel,
            addLabel ? { action: 'add', label: addLabel, glyph: PLUS_SVG } : undefined
          )
          : ''}
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
/* Active fires: no longer drawn on the map                             */
/* ------------------------------------------------------------------ */
/**
 * The flame markers, the burn perimeters and their popups used to live here.
 * They are gone, and the fire data is not.
 *
 * Scattering every incident in the viewport across the map made the feed look
 * like the subject of the app: a dozen flames over country the camper was
 * never going to visit, each one tappable and each one competing with the
 * pins for the same square inch. What a camper actually asks is about a
 * PLACE — "is anything burning near here?" — so fires now answer as part of a
 * point: a breathing dot above the pin you tapped (`fireDots`), and the full
 * list with sizes and containment in the card underneath it
 * (`NearbyFiresCard`). Same feed, same numbers, asked at the moment it means
 * something.
 */

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
   * Conditions at that point, fetched by App and shown as chips on the pin.
   *
   * The map does not fetch these itself because the list view asks the same
   * question about the same point, and two owners means two requests.
   */
  weather: WeatherSnapshot;
  coverage: CellCoverage;
  /** The drive to that point, or null while it is being worked out. */
  route: RouteResult | null;
  /** Hands the drive to Apple or Google Maps. See `src/utils/handoff.ts`. */
  onOpenDirections: () => void;
  /** Lets the open pin go, and gives the camera back. */
  onClearDestination: () => void;
  /** Starts a submission at the dropped pin. Bare ground only. */
  onAddSpotHere: (lat: number, lon: number) => void;
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
  campsites, selectedCampsite, onSelectCampsite, center, zoom, userLocation, weather,
  coverage, route, onOpenDirections, onClearDestination, onAddSpotHere,
  isOfflineMode, onOpenDetailModal, onLocateUser,
  isLocating = false,
  destination, onDropDestination, onPinRefused, onSelectHazardReport, onSelectAlert,
  onSelectBeaconSpot, beaconRefreshKey = 0
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
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
  /**
   * Where the camera was before it closed in on a spot.
   *
   * Tapping a pin zooms in; letting go of it puts the map back where the
   * camper had it. Without this the app kept every zoom it ever took on the
   * camper's behalf, so browsing four spots in a row left you looking at a
   * hundred metres of one clearing with no idea where it sat.
   */
  const preFocusViewRef = useRef<{ center: L.LatLng; zoom: number } | null>(null);
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
  const beaconLayerRef = useRef<L.LayerGroup | null>(null);
  /** State / province boundary lines. Cleared when `showAdmin1` is off. */
  const admin1LayerRef = useRef<L.LayerGroup | null>(null);
  const warningRendererRef = useRef<L.Renderer | null>(null);
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
  const beaconTapRef = useRef(onSelectBeaconSpot);
  beaconTapRef.current = onSelectBeaconSpot;
  const directionsRef = useRef(onOpenDirections);
  directionsRef.current = onOpenDirections;
  const clearDestinationRef = useRef(onClearDestination);
  clearDestinationRef.current = onClearDestination;
  const addSpotRef = useRef(onAddSpotHere);
  addSpotRef.current = onAddSpotHere;
  const detailRef = useRef(onOpenDetailModal);
  detailRef.current = onOpenDetailModal;
  const destinationRef = useRef(destination);
  destinationRef.current = destination;

  /** Weather, signal and land for the open point, as chips. */
  const conditions = React.useMemo(
    () => conditionDots(weather, coverage, destination?.land, route),
    [weather, coverage, destination?.land, route]
  );
  const conditionsRef = useRef(conditions);
  conditionsRef.current = conditions;


  const [activeTileLayer, setActiveTileLayer] = useState<MapTileLayer>('satellite');
  const [isMapReady, setIsMapReady] = useState(false);
  const [showCrownLand, setShowCrownLand] = useState(true);
  const [crownLandAvailable, setCrownLandAvailable] = useState(false);
  const [showLayerMenu, setShowLayerMenu] = useState(false);
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
  const [hazards, setHazards] = useState<HazardAlert[]>([]);
  /**
   * Toilets, taps and fuel within `FACILITY_RADIUS_KM` of the selected spot.
   *
   * Only ever fetched for the pin that is open, because it is an Overpass
   * query per spot and most spots are never opened.
   */
  const [facilities, setFacilities] = useState<NearbyFacility[]>([]);
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

    // Offline is the only reason to stop LOADING. `showBoundaries` decides
    // whether the parcels are painted, not whether they are known: tapping a
    // point has to name the land it is in whether or not it is drawn.
    if (isOfflineMode) {
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
      // Loaded but not painted: everything below this line is drawing.
      if (!showBoundaries) { clearLayer(); return; }
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
      const collection = await fetchBoundaries(box, controller.signal, detail, currentZoom);
      if (cancelled || myId !== requestId) return;

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
   * as on movement, so a spot somebody has just been ticketed at leaves the map
   * at once rather than at the next 50 km pan. And withdrawn spots never arrive
   * here at all — `beacon_spots_near` filters them in SQL — so there is no way
   * for a client bug to leave one drawn.
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
          // a grey ring says "nobody has been here" rather than "Lead".
          title: `${spot.label} — ${style.meaning}`,
          riseOnHover: true
        });
        marker.on('click', () => beaconTapRef.current?.(spot));
        group.addLayer(marker);
      });

      beaconLayerRef.current = group.addTo(map);
    };

    const run = async () => {
      const centre = map.getCenter();
      // Already loaded within ~10 km: the 25 km fetch still covers the view.
      // Tighter than the hazard layer's 50 km because these are small rings
      // that matter at close zoom, not region-wide warnings.
      if (loadedAt && map.distance(centre, L.latLng(loadedAt)) < 10_000) return;

      const spots = await fetchBeaconSpotsNear(centre.lat, centre.lng, 25);
      if (cancelled) return;

      loadedAt = [centre.lat, centre.lng];
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
  const destinationDots = useMemo(() => {
    if (!destination || destination.campsite) return [];
    return [
      ...hazardDots(badgesForPoint(destination.latitude, destination.longitude, hazards)),
      ...fireDots(nearbyFires),
      ...conditions,
      ...facilityDots(facilities)
    ];
  }, [destination, hazards, nearbyFires, conditions, facilities]);
  const destinationDotsRef = useRef(destinationDots);
  destinationDotsRef.current = destinationDots;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const clear = () => {
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
          DIRECTIONS_LABEL,
          'Add spot here',
          freshChipKeys(destinationChipKeysRef.current, destinationDotsRef.current)
        ),
        title: 'Your chosen spot',
        zIndexOffset: 900
      }
    ).addTo(map);

    return clear;
    // Deliberately NOT keyed on the dots: the marker is created once per
    // dropped pin, and the row it carries is grown by the effect below as
    // each lookup lands. Rebuilding the marker instead would drop the pin
    // again, from the top, three times over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, isMapReady]);

  /**
   * Grow the dropped pin's row as the lookups land, without redrawing it.
   *
   * Same rule as `refreshIcon` for submitted pins: if the row would come out
   * identical, the DOM is left alone, and the entrance animation belongs to
   * the drop rather than to every arrival after it.
   */
  useEffect(() => {
    const marker = destinationMarkerRef.current;
    if (!marker) return;
    const fresh = freshChipKeys(destinationChipKeysRef.current, destinationDots);
    // Patched in place for the same reason a submitted pin is: rebuilding the
    // icon would drop the teardrop again and cut the chips off mid-pop.
    if (patchChipRow(marker.getElement(), destinationDots, fresh)) return;
    const icon = buildDestinationIcon(
      destinationDots, DIRECTIONS_LABEL, 'Add spot here', fresh
    );
    const html = (icon.options.html as string) ?? '';
    if (html === destinationHtmlRef.current) return;
    destinationHtmlRef.current = html;
    marker.setIcon(icon);
  }, [destinationDots]);

  /**
   * The open pin sits dead centre.
   *
   * It used to be parked in the strip of map left over above a half-screen
   * panel, because the panel described the pin and covered it at the same
   * time. There is no panel any more — everything it said is on the pin — so
   * the pin gets the middle of the screen, which is where a camper looks.
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

        const centre = L.latLng(destination.latitude, destination.longitude);

        // Already close enough that moving would just look twitchy.
        const shift = map
          .latLngToContainerPoint(centre)
          .distanceTo(map.getSize().divideBy(2));
        if (shift < 8 && zoomTo === map.getZoom()) return;

        // Remember where we were, once per focus, immediately before moving.
        if (first && !preFocusViewRef.current) {
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
   * Closing the card gives the camera back.
   *
   * The tap that opened a spot borrowed the view: it flew in to
   * `CAMPSITE_FOCUS_ZOOM` so the pin's chips had room. Tapping the X, or
   * going back, undoes exactly that — the map returns to the centre and zoom
   * it was at before, which is the wide view the camper was browsing in
   * rather than some fixed "zoomed out" level we picked for them.
   *
   * Only when there is something to undo. A dropped pin that never triggered
   * the fly-in leaves `preFocusViewRef` empty, and closing it moves nothing.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady || destination) return;

    const previous = preFocusViewRef.current;
    preFocusViewRef.current = null;
    focusedDestRef.current = null;
    if (!previous) return;

    try {
      if (prefersReducedMotion()) {
        map.setView(previous.center, previous.zoom, { animate: false });
      } else {
        map.flyTo(previous.center, previous.zoom, { duration: 0.7 });
      }
    } catch { /* map torn down */ }
  }, [destination, isMapReady]);

  /* ------------------------------------------------------------------ */
  /* Weather alerts — localized pins and generalized areas                */
  /* ------------------------------------------------------------------ */
  /**
   * Active alerts, drawn as one of two things: a teardrop pin where the event
   * has a place, or a single merged area with one badge where it covers a
   * region. `EVENT_SCOPE` in alertOverlay.ts decides which, per family.
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

    // TWO panes, because the two kinds of event behave differently.
    //
    //   warningPane      — every generalized area: its fill and its outer
    //                      stroke. pointer-events:none, so a tap on the area
    //                      falls straight through to the map (which drops a spot
    //                      and shows the warning in the sheet).
    //   warningIconPane  — the things you tap: localized fire/flood pins and the
    //                      one badge at the centre of each generalized area.
    //                      Above the campsite pins, because a flame on the map is
    //                      worth more than the pin beneath it.
    if (!map.getPane('warningPane')) {
      map.createPane('warningPane');
      const wpane = map.getPane('warningPane');
      if (wpane) {
        wpane.style.zIndex = '460';
        wpane.style.pointerEvents = 'none';
      }
    }
    if (!map.getPane('warningIconPane')) {
      map.createPane('warningIconPane');
      const ipane = map.getPane('warningIconPane');
      if (ipane) ipane.style.zIndex = '616';
    }

    // One SVG renderer for the areas. SVG rather than the boundary canvas
    // because the fill and the outline have to be two separate paths sharing a
    // pane, and SVG gives per-path control the canvas renderer does not.
    if (!warningRendererRef.current) {
      warningRendererRef.current = L.svg({ pane: 'warningPane', padding: 0.3 });
    }
    // Non-null: just created above if missing.
    const warningRenderer = warningRendererRef.current!;

    /**
     * WHAT USED TO BE HERE, AND WHY IT IS GONE.
     *
     * Every area event was drawn as a soft "cloud": a per-polygon radial
     * gradient built by hand into the renderer's <defs>, a per-path CSS blur to
     * feather the edge, and the family's glyph TILED across the whole shape.
     * Three separate mechanisms, all of them re-measured on every zoom because
     * the gradients lived in projected screen space.
     *
     * It cost a lot and read badly. The tiling is what put a dozen lightning
     * bolts across one valley for a single storm warning, and the blur made the
     * satellite imagery under a warning unreadable without making the warning's
     * own extent any clearer.
     *
     * An area is now a flat semi-transparent fill with a solid outer stroke,
     * and one badge at the middle. No gradients, no defs, no blur, nothing to
     * re-measure on zoom.
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
     * Draw the active warnings, split into the two kinds of event.
     *
     *   LOCALIZED (fire / flood) — a faint hint of the area the agency drew,
     *   plus a crisp, TAPPABLE teardrop pin on the point. Tapping it opens the
     *   warning in the bottom card.
     *
     *   GENERALIZED (heavy rain / storm / heat / cold / smoke / wind) — every
     *   alert of that family in view MERGED into one area, drawn as a
     *   semi-transparent fill with a solid outer stroke, plus ONE tappable
     *   badge at the centre of each merged piece.
     *
     * THE MERGE IS THE POINT. Environment Canada and the NWS issue these
     * products once per forecast zone, so a single rainfall warning arrives as
     * eleven adjacent blocks. Drawn as they come, that is a honeycomb of
     * internal lines with an icon in every cell — which is what the map looked
     * like before, and it read as eleven separate warnings. `mergeAreas`
     * cancels the shared edges so only the outer boundary is stroked, and the
     * badge count drops from one-per-zone to one-per-region.
     *
     * Alerts the feed gave no geometry for are counted, never pinned to a guess.
     *
     * NOTHING IS DRAWN OUTSIDE THE COVERAGE AREA. The weather feeds are wider
     * than this app is: a viewport near the border pulls back marine zones out
     * in the Atlantic, Mexican border counties, whole territories north of
     * 60°. Those were landing as icons and areas on top of the grey — a
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
      /** Generalized alerts, gathered by family so each family merges as one. */
      const areas = new Map<AlertBadge, HazardAlert[]>();

      placeable.forEach((alert) => {
        const badge = alertBadge(alert);
        if (!badge) return;

        if (isGeneralized(badge)) {
          const bucket = areas.get(badge);
          if (bucket) bucket.push(alert);
          else areas.set(badge, [alert]);
          return;
        }

        // A localized event: the area is context, the pin is the event.
        const color = BADGE_COLOR[badge];
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
            html: localizedPinHtml({ kind: badge as LocalizedKind }),
            iconSize: [36, 44],
            iconAnchor: [18, 44]
          }),
          title: `${alert.event} — tap for details`,
          riseOnHover: true
        });
        marker.on('click', () => alertTapRef.current?.(alert));
        group.addLayer(marker);
      });

      areas.forEach((familyAlerts, badge) => {
        const merged = mergeAreas(familyAlerts.map((a) => a.geometry));
        if (!merged) return;
        const color = BADGE_COLOR[badge];

        // The fill: every source piece in one path. `nonzero` is what makes two
        // overlapping warnings of the same family read as one mass instead of
        // punching a hole where they cross — Leaflet's default is `evenodd`,
        // which does exactly that hole.
        group.addLayer(
          L.geoJSON(merged.fill, {
            pane: 'warningPane',
            renderer: warningRenderer,
            interactive: false,
            style: {
              stroke: false,
              fill: true,
              fillColor: color,
              fillOpacity: 0.22,
              fillRule: 'nonzero'
            }
          } as RenderedGeoJSONOptions)
        );

        // The outer boundary, and only the outer boundary.
        group.addLayer(
          L.geoJSON(merged.outline, {
            pane: 'warningPane',
            renderer: warningRenderer,
            interactive: false,
            style: {
              color,
              weight: 2,
              opacity: 0.95,
              fill: false,
              lineJoin: 'round',
              lineCap: 'round'
            }
          } as RenderedGeoJSONOptions)
        );

        merged.labelPoints.forEach((point) => {
          // Which alert this badge opens: the one whose own geometry covers the
          // spot the badge sits on. Several warnings of a family can be merged
          // into one shape, and the badge over Alberta should open Alberta's.
          const owner =
            familyAlerts.find(
              (a) => a.geometry && pointInGeometry(point[0], point[1], a.geometry)
            ) ?? familyAlerts[0];
          const marker = L.marker(point, {
            pane: 'warningIconPane',
            icon: L.divIcon({
              className: 'weather-warning-badge',
              html: centroidBadgeHtml(badge),
              iconSize: [44, 44],
              iconAnchor: [22, 22]
            }),
            title:
              familyAlerts.length > 1
                ? `${WARNING_LABEL[badge]} — ${familyAlerts.length} active warnings here, tap for details`
                : `${owner.event} — tap for details`,
            riseOnHover: true
          });
          marker.on('click', () => alertTapRef.current?.(owner));
          group.addLayer(marker);
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

    return () => {
      cancelled = true;
      controller?.abort();
      if (debounce) clearTimeout(debounce);
      map.off('moveend zoomend', load);
      clear();
      // Drop the SVG renderer too, so a remount does not stack a second one.
      if (warningRendererRef.current) {
        try { map.removeLayer(warningRendererRef.current); } catch { /* detached */ }
        warningRendererRef.current = null;
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
   * Which chips the OPEN pin has already popped in.
   *
   * One set, not one per pin, because only one pin is ever open: it is
   * emptied on every tap, so the stack always plays from nothing, and a
   * lookup landing afterwards only animates the chip it brought.
   */
  const shownChipKeysRef = useRef<Set<string>>(new Set());

  /**
   * Icon for a pinned site: hollow or filled, with its dot row.
   *
   * Hazards lead the row. A heat warning or smoke over the spot changes
   * whether to go at all, which outranks anything about the spot itself.
   */
  const dotsForId = useCallback((id: string): MarkerDot[] => {
    const isSelected = selectedIdRef.current === id;
    return [
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
  }, []);

  const iconForId = useCallback((id: string, animate = false) => {
    const isSelected = selectedIdRef.current === id;
    // A fresh tap forgets what the last one showed, so the stack replays.
    if (animate) shownChipKeysRef.current = new Set();
    const dots = dotsForId(id);
    return buildCampsiteIcon(
      isSelected,
      dots,
      isSelected ? DIRECTIONS_LABEL : undefined,
      isSelected ? freshChipKeys(shownChipKeysRef.current, dots) : undefined
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
      const dots = dotsForId(id);
      if (patchChipRow(
        marker.getElement(),
        dots,
        freshChipKeys(shownChipKeysRef.current, dots)
      )) {
        // The cached HTML no longer describes the DOM, so the next full
        // rebuild must not be skipped as a no-op.
        iconHtmlRef.current.delete(id);
        return;
      }
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
    // The last spot's facilities are not this spot's. Cleared before either
    // icon is rebuilt, so a toilet 4 km from the previous pin cannot appear
    // over the new one for the moment before the fetch lands.
    facilitiesRef.current = [];
    if (previousId) {
      refreshIcon(previousId);
      markersRef.current.get(previousId)?.setZIndexOffset(0);
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
      return;
    }

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
    }, 300);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      setFacilities([]);
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

  const runFireTour = useCallback(async () => {
    const map = mapRef.current;
    const point = readPointRef.current;
    const near = nearbyFiresRef.current;
    if (!map || !point || !near.length || tourRunningRef.current) return;

    tourRunningRef.current = true;
    const reduced = prefersReducedMotion();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, reduced ? ms / 3 : ms));
    const home = { center: map.getCenter(), zoom: map.getZoom() };
    // Five is as many labels as fit on a phone before they stack on top of
    // each other; the rest are still counted on the chip.
    const shown = near.slice(0, 5);

    const layer = L.layerGroup().addTo(map);
    tourLayerRef.current = layer;
    /**
     * The pin's own row of chips steps aside while the fires are on screen.
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
      const bounds = L.latLngBounds([point.lat, point.lon] as L.LatLngExpression, [
        point.lat, point.lon
      ] as L.LatLngExpression);
      shown.forEach((n) => bounds.extend([n.fire.centroid.lat, n.fire.centroid.lon]));

      map.fitBounds(bounds, {
        padding: L.point(70, 90),
        maxZoom: 11,
        animate: !reduced
      });
      await wait(750);

      for (const { fire, distanceKm } of shown) {
        if (!tourLayerRef.current) return;
        const held = isUnderControl(fire);
        const status = fire.status?.trim()
          ? fire.status
          : held
          ? 'Reported under control'
          : 'Not reported under control';

        L.marker([fire.centroid.lat, fire.centroid.lon], {
          icon: L.divIcon({
            className: 'wl-fire-stop',
            html:
              `<div class="wl-fire-stop-wrap">` +
              `<span class="wl-fire-stop-label${held ? '' : ' wl-fire-stop-label-hot'}">` +
              `${escapeHtml(status)}` +
              `<em>${escapeHtml(fire.name)} · ${distanceKm.toFixed(1)} km away</em>` +
              `</span>` +
              `<span class="wl-fire-stop-glyph" aria-hidden="true">🔥</span>` +
              `</div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15]
          }),
          interactive: false,
          zIndexOffset: 800
        }).addTo(layer);

        await wait(850);
      }

      await wait(900);
    } finally {
      layer.remove();
      tourLayerRef.current = null;
      container.classList.remove('wl-touring');
      try {
        if (reduced) map.setView(home.center, home.zoom, { animate: false });
        else map.flyTo(home.center, home.zoom, { duration: 0.8 });
      } catch { /* map torn down */ }
      tourRunningRef.current = false;
    }
  }, []);

  // A tour still running when the map goes away would keep adding flames to a
  // layer nobody can see, and then fly a torn-down camera home.
  useEffect(() => () => { tourLayerRef.current?.remove(); tourLayerRef.current = null; }, []);

  /**
   * A tap on something the open pin offers: a facility chip, the fire chip,
   * the directions button, or the close button.
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
      const hit = target?.closest?.('[data-facility],[data-action]') as HTMLElement | null;
      if (!hit) return;

      const action = hit.getAttribute('data-action');
      const facilityId = hit.getAttribute('data-facility');
      const facility = facilityId
        ? facilitiesRef.current.find((f) => f.id === facilityId)
        : undefined;
      if (!action && !facility) return;

      event.preventDefault();
      event.stopPropagation();

      if (facility) setFacilityTrip({ facility, route: null, loading: true });
      else if (action === 'fires') void runFireTour();
      else if (action === 'directions') directionsRef.current();
      else if (action === 'close') clearDestinationRef.current();
      else if (action === 'details' && destinationRef.current?.campsite) {
        detailRef.current(destinationRef.current.campsite);
      } else if (action === 'add') {
        const at = readPointRef.current;
        if (at) addSpotRef.current(at.lat, at.lon);
      }
    };

    container.addEventListener('click', onTap, true);
    return () => container.removeEventListener('click', onTap, true);
  }, [isMapReady, runFireTour]);

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
    if (!map || !isMapReady || !tripFacility || readLat === null || readLon === null) return;

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
      <div className="absolute top-3 left-3 z-[1000] flex flex-col gap-1 max-w-[min(16rem,calc(100%-5rem))]">
        {isOfflineMode && (
          <div className="bg-amber-500 text-slate-950 px-3 py-1.5 rounded-xl font-bold text-xs shadow-xl flex items-center gap-2 border border-amber-300">
            <span className="w-2 h-2 rounded-full bg-slate-950 animate-ping" />
            Offline — saved maps and spots
          </div>
        )}

        {!isWithinCoverage(center[0], center[1]) && (
          <div className="bg-slate-800/95 backdrop-blur-md border border-slate-600 text-slate-300 px-3 py-1.5 rounded-xl text-[11px] font-semibold shadow-xl flex items-start gap-2 anim-in-up">
            <Eye className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
            <span>Outside coverage. Wandrlust supports {COVERAGE_LABEL}.</span>
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
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-[1400] w-[min(23rem,calc(100%-1.5rem))] anim-in-up">
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
                <p className="text-[10px] text-slate-400">
                  {FACILITY_LABEL[facilityTrip.facility.kind]} ·{' '}
                  {facilityTrip.facility.distanceKm} km from this spot
                  {facilityTrip.facility.fee === true && ' · charges a fee'}
                </p>
                <p className="text-[10px] text-slate-300 mt-0.5">
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
                className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-100 shrink-0"
                aria-label="Hide this facility"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <p className="text-[9px] text-slate-500 leading-tight mt-1.5">
              Mapped by an OpenStreetMap volunteer. Nobody has checked whether it
              is open, maintained or still there.
            </p>

            <button
              type="button"
              onClick={() =>
                openDirections(
                  facilityTrip.facility.latitude,
                  facilityTrip.facility.longitude,
                  [readLat, readLon]
                )
              }
              className="mt-2 w-full px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2"
            >
              <Navigation className="w-3.5 h-3.5" />
              Take me there in {directionsAppName()}
            </button>
          </div>
        </div>
      )}

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
            {/*
              The accuracy caveat, now that the standing chip over the map is
              gone. It sits under the switch that draws the parcels, so it is
              read by whoever turns them on, and it says the two things that
              must never be lost: the edges are a guess with a range, and a
              blank map is missing data rather than missing public land.
            */}
            {showBoundaries && (
              <p className="px-2 pb-1.5 text-[9px] text-slate-500 leading-tight">
                Edges are drawn as a fade, not a line — roughly{' '}
                {UNCERTAINTY_LABEL.cadastral_derived} to {UNCERTAINTY_LABEL.generalised}{' '}
                out depending on the source, and not permission to camp. Nothing
                drawn means no data here, not private land.
              </p>
            )}
            {/*
              Said when the layer is OFF, because "off" could easily be read as
              "the app has stopped knowing". It hasn't: the parcels are still
              loaded and a tap still names the land, its stay limit, its permit
              and its fire ban. Only the paint is gone.
            */}
            {!showBoundaries && (
              <p className="px-2 pb-1.5 text-[9px] text-slate-500 leading-tight">
                Off by default — the map stays readable and tapping any point
                still tells you which public land it is in.
              </p>
            )}
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
            {/*
              No "Active fires" toggle here any more: there is no fire layer
              to switch off. Fires are reported on the pin you tap, which is
              a safety answer and not a layer.
            */}
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
