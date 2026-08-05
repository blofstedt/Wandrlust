import { BoundingBox, bboxIntersectsCoverage, clampToCoverage } from '../config/coverage';

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
    color: '#059669', fillColor: '#10B981', fillOpacity: 0.28,
    label: 'Designated General Use'
  },
  managing_agency: {
    color: '#B45309', fillColor: '#F59E0B', fillOpacity: 0.2,
    label: 'Federal land (BLM / USFS)'
  },
  managed_zone: {
    color: '#0E7490', fillColor: '#06B6D4', fillOpacity: 0.2,
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

/* -------------------------------------------------------------------------- */
/* Fetching                                                                    */
/* -------------------------------------------------------------------------- */

/** Recently fetched viewports, so panning back somewhere is free. */
const responseCache = new Map<string, { at: number; collection: BoundaryCollection }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
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
  signal?: AbortSignal
): Promise<BoundaryCollection | null> => {
  if (!bboxIntersectsCoverage(box)) return EMPTY_BOUNDARIES;

  const clamped = clampToCoverage(box);
  const params = new URLSearchParams({
    minLat: clamped.minLat.toFixed(5),
    minLon: clamped.minLon.toFixed(5),
    maxLat: clamped.maxLat.toFixed(5),
    maxLon: clamped.maxLon.toFixed(5)
  });
  const query = params.toString();

  const cached = responseCache.get(query);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.collection;

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
      const oldest = responseCache.keys().next().value;
      if (oldest) responseCache.delete(oldest);
    }
    responseCache.set(query, { at: Date.now(), collection });

    return collection;
  } catch (error) {
    if (signal?.aborted || (error as Error)?.name === 'AbortError') return null;
    return EMPTY_BOUNDARIES;
  }
};
