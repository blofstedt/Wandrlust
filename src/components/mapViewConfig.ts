/**
 * Map view configuration — tile layers, zoom thresholds, pan bounds, and the
 * two small view-centering helpers Leaflet's marker clustering needs.
 *
 * Split out of MapComponent.tsx purely to make that file smaller; nothing
 * here behaves any differently than it did inline. No React, no component
 * state — just constants and pure functions.
 */
import L from 'leaflet';
import type { MapTileLayer } from '../types';
import { MAP_VIEW_BBOX } from '../config/coverage';

export const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export const TILE_URLS: Record<MapTileLayer, { url: string; attribution: string; label: string }> = {
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
export type RenderedGeoJSONOptions = L.GeoJSONOptions & { renderer: L.Renderer };

/**
 * Shared tile options that keep the network quiet while the map is moving.
 *
 * By default Leaflet requests a fresh grid of tiles at every intermediate zoom
 * level of a pinch or scroll, so a two-level zoom fires three rounds of
 * requests and throws two of them away. Waiting for the gesture to finish means
 * one round instead, which is most of why zooming felt like wading through mud.
 */
export const TILE_PERFORMANCE = {
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
export const UNDERLAY_NATIVE_ZOOM = 8;

/**
 * How close the camera comes when a camper taps a pin.
 *
 * Close enough that the tapped pin's expanded chips have the screen to
 * themselves and the roads in to the spot are drawn; not so close that the
 * surroundings vanish and the camper loses the sense of where the spot sits.
 * Never zooms OUT to reach it — see the effect that uses it.
 */
export const CAMPSITE_FOCUS_ZOOM = 14;

/**
 * How soft the edge of a weather cloud is, in screen pixels.
 *
 * Enough that no straight survey line from a forecast region survives, not so
 * much that the area stops having a shape. A camper has to be able to tell
 * roughly where the smoke is and must NOT be able to point at the line where
 * it stops, because there isn't one.
 */
export const CLOUD_BLUR_PX = 11;

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
export const PAN_BOUNDS = L.latLngBounds(
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
export const TILE_BOUNDS = PAN_BOUNDS;

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


export const centreLeavingRoom = (
  map: L.Map, at: L.LatLng, coveredPx: number, zoom: number
): L.LatLng => {
  const covered = Math.max(0, Math.min(coveredPx, map.getSize().y - 140));
  if (covered <= 0) return at;
  return map.unproject(map.project(at, zoom).add(L.point(0, covered / 2)), zoom);
};

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
export const clusterView = (map: L.Map): L.Map =>
  new Proxy(map, {
    get: (target, prop) => (prop === 'getMinZoom' ? () => 0 : Reflect.get(target, prop)),
    set: (target, prop, value) => Reflect.set(target, prop, value)
  });

