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

/**
 * Fetch land boundaries intersecting a viewport.
 * Returns an empty collection (never throws) when out of coverage or offline.
 */
export const fetchBoundaries = async (
  box: BoundingBox,
  signal?: AbortSignal
): Promise<BoundaryCollection> => {
  if (!bboxIntersectsCoverage(box)) return EMPTY_BOUNDARIES;

  const clamped = clampToCoverage(box);
  const params = new URLSearchParams({
    minLat: clamped.minLat.toFixed(5),
    minLon: clamped.minLon.toFixed(5),
    maxLat: clamped.maxLat.toFixed(5),
    maxLon: clamped.maxLon.toFixed(5)
  });

  try {
    const response = await fetch(`/api/boundaries?${params.toString()}`, { signal });
    if (!response.ok) return EMPTY_BOUNDARIES;

    const data = await response.json();
    if (data?.type !== 'FeatureCollection') return EMPTY_BOUNDARIES;

    return {
      type: 'FeatureCollection',
      features: Array.isArray(data.features) ? data.features : [],
      meta: data.meta ?? { sources: [] }
    };
  } catch {
    return EMPTY_BOUNDARIES;
  }
};
