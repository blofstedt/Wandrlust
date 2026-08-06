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
  };
}

export const EMPTY_BOUNDARIES: BoundaryCollection = {
  type: 'FeatureCollection',
  features: [],
  meta: { sources: [] }
};

/** Colours keyed by what the data actually asserts. */
export const BOUNDARY_STYLES: Record<
  BoundaryConfidence,
  { color: string; fillColor: string; fillOpacity: number; label: string }
> = {
  designated_general_use: {
    color: '#34D399', fillColor: '#10B981', fillOpacity: 0.4,
    label: 'Designated General Use'
  },
  managing_agency: {
    color: '#FBBF24', fillColor: '#F59E0B', fillOpacity: 0.32,
    label: 'Federal land (BLM / USFS)'
  },
  managed_zone: {
    color: '#22D3EE', fillColor: '#06B6D4', fillOpacity: 0.32,
    label: 'Managed zone (PLUZ)'
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
 */
export const requestBoxFor = (view: BoundingBox, zoom: number): BoundingBox => {
  const padLat = (view.maxLat - view.minLat) * 0.25;
  const padLon = (view.maxLon - view.minLon) * 0.25;
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

/** Recently fetched viewports, so panning back somewhere is free. */
const responseCache = new Map<string, { at: number; collection: BoundaryCollection }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
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

    return collection;
  } catch (error) {
    if (signal?.aborted || (error as Error)?.name === 'AbortError') return null;
    return EMPTY_BOUNDARIES;
  }
};
