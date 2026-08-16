import localforage from 'localforage';
import {
  BoundingBox, bboxIntersectsCoverage, clampToCoverage, overviewMinAreaSqKm
} from '../config/coverage';

/**
 * Client for the `/api/boundaries` proxy.
 *
 * The server returns GeoJSON where every feature carries provenance in its
 * properties, so the map can style and label polygons honestly rather than
 * lumping everything under one "public land" colour.
 */

/**
 * How much the underlying dataset actually tells us:
 *  - `designated_general_use` — the source explicitly designates this polygon
 *    as a General Use Area (currently only Ontario CLUPA).
 *  - `managing_agency` — we know which agency administers the surface, but the
 *    dataset says nothing about permitted activities.
 *  - `managed_zone` — a named management zone with its own local rules.
 */
export type BoundaryConfidence =
  | 'designated_general_use'
  | 'managing_agency'
  | 'managed_zone';

/**
 * How much to trust a polygon's EDGES.
 *
 * None of these are survey-grade. BLM's own Surface Management Agency
 * metadata states the data "do not illustrate land status ownership pattern
 * boundaries". Legal boundaries live in survey plans and title registries.
 */
export type EdgeAccuracy = 'generalised' | 'administrative' | 'cadastral_derived';

/** On what basis we claim camping is permitted. */
export type CampingBasisKind =
  | 'explicit_designation'
  | 'open_access_flag'
  | 'agency_policy_inference';

export const EDGE_ACCURACY_COPY: Record<EdgeAccuracy, string> = {
  generalised: 'Generalised for mapping. Edges may be off by hundreds of metres.',
  administrative: 'Agency administrative boundary. Good regional shape, not survey-grade.',
  cadastral_derived: 'Derived from a survey fabric. Best available, still not a legal boundary.'
};

export const CAMPING_BASIS_COPY: Record<CampingBasisKind, string> = {
  explicit_designation:
    'The source explicitly designates this area for general or dispersed use.',
  open_access_flag:
    'The source says public access is open. That permits entry, not necessarily overnight camping.',
  agency_policy_inference:
    'Only the managing agency is known. Camping is inferred from that agency\u2019s general policy.'
};

export interface BoundaryFeatureProperties {
  _source: string;
  _sourceName: string;
  _attribution: string;
  _confidence: BoundaryConfidence;
  _name: string;
  _designation: string;
  _edgeAccuracy?: EdgeAccuracy;
  _campingBasisKind?: CampingBasisKind;
  _basis?: string;

  /* ---- Rules the land manager sets for this parcel ------------------
   * Present only when they have been recorded against the land. Every one of
   * these comes from the agency; nothing a camper submitted ever lands here,
   * because "somebody stayed and nobody minded" is not a regulation.
   *
   * Absent means nobody has recorded it, NOT that the rule doesn't exist —
   * so the UI says "check with the manager" rather than implying no limit.
   */
  _stayLimitDays?: number | null;
  _moveDistanceKm?: number | null;
  _permitRequired?: boolean | null;
  _permitName?: string | null;
  _permitUrl?: string | null;
  _campfirePolicy?: string | null;
  _fireBanActive?: boolean | null;
  _fireBanCheckedAt?: string | null;
  _wastePolicy?: string | null;
  _setbackWaterM?: number | null;
  _leaveNoTrace?: string | null;
  _restrictions?: string | null;
}

export interface BoundaryFeature {
  type: 'Feature';
  geometry: unknown;
  properties: BoundaryFeatureProperties;
}

export interface BoundarySourceStatus {
  id: string;
  label: string;
  attribution: string;
  confidence: BoundaryConfidence;
  available: boolean;
  featureCount: number;
}

export interface BoundaryCollection {
  type: 'FeatureCollection';
  features: BoundaryFeature[];
  meta: {
    sources: BoundarySourceStatus[];
    disclaimer?: string;
    skipped?: string;
    /**
     * How hard the server generalised this geometry, in degrees.
     *
     * THE MAP NEEDS THIS TO MERGE PARCELS AT ALL. Two abutting parcels are
     * merged into one shape by cancelling the edge they share, which works
     * only if both sides of that edge still have the same vertices. The
     * server simplifies each parcel independently, so at a wide viewport the
     * two sides of a shared boundary drift apart by up to this much — and a
     * merge tolerance of a fixed hundred metres stops recognising them as the
     * same edge, which is when a province full of Crown land goes back to
     * drawing as a mesh of thousands of separate outlines.
     */
    simplifyDegrees?: number;
  };
}

export const EMPTY_BOUNDARIES: BoundaryCollection = {
  type: 'FeatureCollection',
  features: [],
  meta: { sources: [] }
};

/** Colours keyed by what the data actually asserts. */
/**
 * What the map paints, and the only distinction it paints.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACED THREE COLOURS KEYED ON `confidence`
 * ---------------------------------------------------------------------------
 *
 * The map used to draw a different colour per confidence tier: green for
 * Ontario's General Use Areas, amber for `managing_agency`, cyan for Alberta's
 * PLUZ. That is a statement about HOW WE KNOW, and it was being used to answer
 * a question the camper is actually asking, which is WHETHER I CAN SLEEP HERE.
 *
 * It also aged badly. `managing_agency` was written when the only members were
 * BLM and the Forest Service, so its label read "Federal land (BLM / USFS)" —
 * and every Canadian Crown land source added since (Alberta's Green Area,
 * Saskatchewan's and Manitoba's provincial forests) landed in that same tier
 * and was therefore being labelled as American federal land.
 *
 * So there is one group for land you may camp on, whoever administers it and
 * however we came to know, and a separate, deliberately quieter treatment for
 * the one kind of land that does NOT say that.
 *
 * THE LINE THAT MUST NOT MOVE. PAD-US `open_access_flag` means the public may
 * ENTER — a state park is usually open access and usually forbids sleeping.
 * Folding that in with BLM under one "camp here" colour would be the app
 * claiming something no dataset says, so it keeps its own group and its own
 * words. Everything else here has camping permitted either by explicit
 * designation or by the managing agency's own general policy, which is the
 * same standard the seeder applies in `scripts/landSources.ts`.
 */
export type BoundaryGroup = 'campable' | 'access_only';

/**
 * Which group a parcel belongs to.
 *
 * A missing `_campingBasisKind` reads as campable, because every source wired
 * into this app asserts camping except PAD-US, which always sets the flag. The
 * fallback is therefore the common case, not a guess about unknown land.
 */
export const boundaryGroupOf = (
  properties: { _campingBasisKind?: CampingBasisKind } | undefined | null
): BoundaryGroup =>
  properties?._campingBasisKind === 'open_access_flag' ? 'access_only' : 'campable';

export const BOUNDARY_GROUP_STYLES: Record<
  BoundaryGroup,
  { color: string; fillColor: string; fillOpacity: number; label: string; detail: string }
> = {
  campable: {
    color: '#34D399', fillColor: '#10B981', fillOpacity: 0.36,
    label: 'Public land — camping allowed',
    detail:
      'BLM, National Forest and Canadian Crown land and provincial forests, drawn as one. ' +
      'Camping is permitted here by designation or by the managing agency’s policy. ' +
      'Local closures, fire bans and permit rules still apply and are not all in this data.'
  },
  access_only: {
    color: '#60A5FA', fillColor: '#3B82F6', fillOpacity: 0.2,
    label: 'Open to the public — camping not confirmed',
    detail:
      'The source says the public may enter. It does not say anyone may stay overnight, ' +
      'and many areas flagged this way forbid it. Check before planning to sleep here.'
  }
};

/* -------------------------------------------------------------------------- */
/* Request geometry                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Grid cell size, in degrees, that requests are snapped to at a given zoom.
 *
 * Asking for the exact viewport means every nudge of the map is a brand new
 * bounding box, so nothing ever hits a cache — client, server, or browser —
 * and five government ArcGIS services get re-queried for a view the user has
 * already seen. Snapping the request outward to a grid makes small pans
 * resolve to the identical URL, which is what makes panning feel instant.
 */
const gridSize = (zoom: number): number =>
  // Rounded, because mid-animation Leaflet reports a fractional zoom, and a
  // fractional exponent gives a grid that no two requests ever agree on.
  Math.pow(2, 7 - Math.min(Math.max(Math.round(zoom), 7), 14));

/**
 * Turn a viewport into the box we actually ask for: padded, so a short pan
 * stays inside data we already hold, then snapped out to the grid.
 *
 * The pad is 0.6 (60% on each side — total ~2.2x the viewport) so a small
 * pan on a phone does not invalidate the loaded box and trigger a
 * refetch. The earlier 0.25 (1.5x total) was tight enough that a
 * one-centimetre pan on the device showed a "Loading boundaries…"
 * spinner and a brief gap where the old layer was off the map but the
 * new one had not landed.
 */
export const requestBoxFor = (view: BoundingBox, zoom: number): BoundingBox => {
  const padLat = (view.maxLat - view.minLat) * 0.6;
  const padLon = (view.maxLon - view.minLon) * 0.6;
  const cell = gridSize(zoom);

  return {
    minLat: Math.floor((view.minLat - padLat) / cell) * cell,
    minLon: Math.floor((view.minLon - padLon) / cell) * cell,
    maxLat: Math.ceil((view.maxLat + padLat) / cell) * cell,
    maxLon: Math.ceil((view.maxLon + padLon) / cell) * cell
  };
};

/** True when `outer` fully contains `inner` — i.e. no new data is needed. */
export const boxContains = (outer: BoundingBox, inner: BoundingBox): boolean =>
  outer.minLat <= inner.minLat && outer.minLon <= inner.minLon &&
  outer.maxLat >= inner.maxLat && outer.maxLon >= inner.maxLon;

/**
 * How much boundary data to ask for.
 *
 *  - `full`     — everything intersecting the viewport, at viewport detail.
 *  - `overview` — only the large parcels, heavily generalised, on a very coarse
 *                 grid. Used below BOUNDARY_MIN_ZOOM, where the point is "there
 *                 is public land over there", not "the edge is exactly here".
 */
export type BoundaryDetail = 'full' | 'overview';

/**
 * The box an overview request asks for.
 *
 * Snapped to a grid measured in map-widths, not in the small cells
 * `requestBoxFor` uses. At these zooms most of a continent is on screen, so a
 * grid that only just exceeds the viewport means two drags walk straight off
 * the loaded data and every gesture becomes a fresh request — which is exactly
 * the flicker this tier exists to remove.
 *
 * The cells are therefore several screens wide: 8° at zoom 6 up to 64° at zoom
 * 3, where a single request covers the entire supported area. Panning around
 * North America at zoom 3-4 makes one request for the whole session; at zoom 5-6
 * it makes a handful, and each is reused for a long time afterwards.
 */
export const overviewBoxFor = (view: BoundingBox, zoom: number): BoundingBox => {
  const cell = Math.pow(2, 9 - Math.min(Math.max(Math.round(zoom), 3), 6));
  return {
    minLat: Math.floor(view.minLat / cell) * cell,
    minLon: Math.floor(view.minLon / cell) * cell,
    maxLat: Math.ceil(view.maxLat / cell) * cell,
    maxLon: Math.ceil(view.maxLon / cell) * cell
  };
};

/* -------------------------------------------------------------------------- */
/* Fetching                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Two-layer cache for boundary responses.
 *
 *   1. In-memory `Map` — short TTL (5 min for full, 12 h for overview).
 *      Panning back across a recently-tapped region in the same session
 *      is free, and the wide-zoom borders survive a long browse.
 *
 *   2. localforage `wandrlust_boundaries` — long TTL (7 days). Survives
 *      reloads and cold starts, so a returning user reads the same data
 *      they got a week ago without a round trip. The data does not
 *      change at parcel scale (BLM/USFS boundaries are static), so 7
 *      days is well within what the answer can support.
 *
 * The disk key is rounded to 2 decimal places (~1.1 km) — coarser
 * than the request (5 decimals, ~1 m) so two slightly different
 * bboxes hit the same entry, but fine enough that you don't fetch a
 * whole region for a one-cell pan.
 */
const boundaryStore = localforage.createInstance({
  name: 'wandrlust',
  storeName: 'wandrlust_boundaries',
  description: 'Cached boundary responses by rounded viewport'
});

/** Recently fetched viewports, so panning back somewhere is free. */
const responseCache = new Map<string, { at: number; collection: BoundaryCollection }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Disk cache TTL — 7 days. Public-land boundaries are static. */
const DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Overview tiles are kept for the whole session.
 *
 * There are only a few of them, they cover a continent each, and the thing
 * they describe — which government agency administers a million-acre block of
 * land — does not change while somebody is looking at the map. Expiring them
 * on the same five-minute timer as detailed viewports meant the wide-zoom
 * borders vanished and re-fetched for no reason a camper could perceive.
 */
const OVERVIEW_TTL_MS = 12 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 40;

interface DiskEntry { at: number; collection: BoundaryCollection }

const diskKey = (query: string): string => {
  // The query is a sorted URLSearchParams string; round each numeric
  // value to 2 decimals so a slightly larger/smaller box hits the
  // same disk entry.
  const params = new URLSearchParams(query);
  for (const k of ['minLat', 'minLon', 'maxLat', 'maxLon']) {
    const v = params.get(k);
    if (v) params.set(k, Number(v).toFixed(2));
  }
  return params.toString();
};

/**
 * Fetch land boundaries intersecting a viewport.
 *
 * Never throws. Returns an empty collection when out of coverage or when the
 * request fails, and `null` when the request was cancelled — the caller must
 * keep whatever it is already showing in that case. Returning an empty
 * collection for a cancellation is what used to make boundaries blink out
 * every time the map moved.
 */
export const fetchBoundaries = async (
  box: BoundingBox,
  signal?: AbortSignal,
  detail: BoundaryDetail = 'full',
  zoom = 7
): Promise<BoundaryCollection | null> => {
  if (!bboxIntersectsCoverage(box)) return EMPTY_BOUNDARIES;

  const clamped = clampToCoverage(box);
  const params = new URLSearchParams({
    minLat: clamped.minLat.toFixed(5),
    minLon: clamped.minLon.toFixed(5),
    maxLat: clamped.maxLat.toFixed(5),
    maxLon: clamped.maxLon.toFixed(5)
  });
  if (detail === 'overview') {
    params.set('detail', 'overview');
    params.set('minAreaSqKm', String(overviewMinAreaSqKm(zoom)));
  }
  const query = params.toString();

  const ttl = detail === 'overview' ? OVERVIEW_TTL_MS : CACHE_TTL_MS;
  const cached = responseCache.get(query);
  if (cached && Date.now() - cached.at < ttl) return cached.collection;

  // Disk cache: warm the in-memory layer from a coarser, longer-lived
  // localforage entry before going to the network. The key is rounded
  // to 2 decimals so a one-cell pan that lands in the same ~1.1 km
  // region hits the same entry without a fetch.
  const dk = diskKey(query);
  try {
    const disk = await boundaryStore.getItem<DiskEntry>(dk);
    if (disk && Date.now() - disk.at < DISK_TTL_MS) {
      responseCache.set(query, { at: Date.now(), collection: disk.collection });
      return disk.collection;
    }
  } catch {
    // localforage failures are never fatal — the in-memory layer is
    // still warm for this session.
  }

  try {
    const response = await fetch(`/api/boundaries?${query}`, { signal });
    if (!response.ok) return EMPTY_BOUNDARIES;

    const data = await response.json();
    if (data?.type !== 'FeatureCollection') return EMPTY_BOUNDARIES;

    const collection: BoundaryCollection = {
      type: 'FeatureCollection',
      features: Array.isArray(data.features) ? data.features : [],
      meta: data.meta ?? { sources: [] }
    };

    if (responseCache.size >= CACHE_MAX_ENTRIES) {
      // Evict the oldest DETAILED viewport. Overview tiles are exempt: there
      // are only a few, they are what makes zooming out feel instant, and
      // evicting one costs a continent-sized refetch to save one map entry.
      const oldest = [...responseCache.keys()].find((k) => !k.includes('detail=overview'));
      if (oldest) responseCache.delete(oldest);
    }
    responseCache.set(query, { at: Date.now(), collection });
    // Fire-and-forget disk write. We do not block the caller on
    // IndexedDB — the in-memory layer is already warm, and the disk
    // write is purely a session bonus for next reload.
    boundaryStore.setItem<DiskEntry>(dk, { at: Date.now(), collection }).catch(() => undefined);

    return collection;
  } catch (error) {
    if (signal?.aborted || (error as Error)?.name === 'AbortError') return null;
    return EMPTY_BOUNDARIES;
  }
};
