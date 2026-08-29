import localforage from 'localforage';
import {
  BoundingBox, bboxIntersectsCoverage, clampToCoverage, OVERVIEW_MIN_AREA_SQ_KM
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
    /** Which tier this came from — see `BoundaryDetail`. */
    detail?: BoundaryDetail;
    /**
     * A source withheld polygons, so what is drawn is a sample.
     *
     * Always in the direction of "there is more than this", never less, and
     * the map says so on screen rather than letting a thinly-painted province
     * read as an empty one.
     */
    truncated?: boolean;
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
    /**
     * THIS EMPTY ANSWER IS A FAILURE, NOT A FACT.
     *
     * -----------------------------------------------------------------------
     * WHY THE MAP HAD TO BE TAUGHT THE DIFFERENCE
     * -----------------------------------------------------------------------
     *
     * `features: []` used to mean four completely different things — the
     * request failed, the server refused the viewport, every upstream service
     * timed out, or there genuinely is no public land here — and the map could
     * not tell them apart, so it drew all four the same way: a blank
     * continent. Zooming out over Alberta hit the third case, the boundaries
     * vanished, and the app said "there is nowhere to camp in Alberta" as
     * confidently as if it knew.
     *
     * When this is true, NOTHING has been learned about the ground. The caller
     * must keep whatever it is already showing and say the view failed to
     * load, and the answer must never be cached — an unavailable response that
     * lands in the seven-day disk cache takes a whole zoom level out for a
     * week.
     *
     * Absent or false means the empty IS the answer: everything was asked, and
     * there is nothing here.
     */
    unavailable?: boolean;
  };
}

export const EMPTY_BOUNDARIES: BoundaryCollection = {
  type: 'FeatureCollection',
  features: [],
  meta: { sources: [] }
};

/**
 * Nothing was learned. Distinct from `EMPTY_BOUNDARIES`, which is a real
 * "we asked everything and there is no public land here".
 */
const unavailableBoundaries = (): BoundaryCollection => ({
  type: 'FeatureCollection',
  features: [],
  meta: { sources: [], unavailable: true }
});

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
 * however we came to know. There used to be a second, deliberately quieter
 * tier — `access_only` — for PAD-US parcels flagged "open to the public but
 * camping not confirmed". Those parcels were REMOVED from the registry (see
 * `scripts/landSources.ts` / `server/boundaryRoutes.ts`): the OA flag means
 * the public may ENTER, not that anyone may sleep there, and it was being
 * drawn as campable-looking land. The group is kept as a dead branch so an
 * old cached feature degrades to amber rather than reading as confirmed
 * campable.
 */
export type BoundaryGroup = 'campable' | 'access_only';

/**
 * Which group a parcel belongs to.
 *
 * A missing `_campingBasisKind` reads as campable, because every source wired
 * into this app asserts camping. The `access_only` branch is defensive only:
 * PAD-US "open access" parcels (the one source that set
 * `open_access_flag`) were removed, and the server drops any stale copy of
 * them, so this never fires in practice — kept so an old cached feature
 * degrades to amber instead of reading as confirmed campable.
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
    color: '#F59E0B', fillColor: '#D97706', fillOpacity: 0.2,
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
 *  - `mid`      — the step between: the overview data windowed much finer
 *                 than the coarse blocks. Rendered locally from the bundled
 *                 overview file (or the held remote overview), so it never
 *                 makes its own request.
 *  - `overview` — only the large parcels, heavily generalised, on a very coarse
 *                 grid. Used below BOUNDARY_MID_ZOOM, where the point is "there
 *                 is public land over there", not "the edge is exactly here".
 */
export type BoundaryDetail = 'full' | 'mid' | 'overview';

/**
 * THE OVERVIEW NO LONGER HAS A BOX FUNCTION, AND THAT IS THE POINT.
 *
 * There used to be one here — `overviewBoxFor` — that derived a padded,
 * grid-snapped request box from the viewport, and it went through several
 * careful revisions trying to make panning cheap without spending the record
 * budget off-screen. Every version of it shared the flaw that no version could
 * fix: a box that moves produces a different sample of the same continent each
 * time it moves, and the map drew each new sample over the last one, so public
 * land appeared and disappeared as you scrolled.
 *
 * The overview now asks for `OVERVIEW_BOX` — the whole coverage area, the same
 * rectangle every time — and the map holds that one answer for as long as it is
 * open. See the comment on OVERVIEW_BOX in config/coverage.ts.
 */

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

/**
 * BUMP THIS WHENEVER THE SERVER STARTS ANSWERING DIFFERENTLY.
 *
 * Boundaries are cached hard on purpose — twelve hours in memory, seven days
 * on disk, six hours in the browser's own HTTP cache — because a national
 * forest does not move and re-fetching one is a slow, flickery map.
 *
 * The cost of that is a fix nobody can see. The day the API started asking
 * government services for the BIGGEST areas in view instead of the first ones
 * it happened to be handed, every phone that had already looked at Ontario
 * carried on drawing the old scatter of flecks for a week, from its own disk,
 * and the map looked exactly as broken as before.
 *
 * So the epoch rides along in the request. It changes the URL, which misses
 * the browser cache; it is part of the query string the disk key is built
 * from, which misses localforage; and the server ignores it entirely, so
 * nothing upstream is fragmented by it.
 *
 * ADDING A SOURCE COUNTS. It was written for a change in HOW the API chooses
 * parcels and then forgotten the same day for a change in WHICH provinces it
 * has any: New Brunswick and Nova Scotia went live and nobody who had already
 * opened the map saw either of them, because their phones had a perfectly
 * valid answer from an hour earlier that predated both. Any change to what the
 * map can draw — a new source, a new filter, a different subset — is a bump.
 *
 *   2 → biggest-parcels-first, and Ontario stopped drawing as confetti
 *   3 → New Brunswick and Nova Scotia Crown land
 *   4 → the Maritimes weld instead of falling back to three big parcels
 *   5 → and weld properly: a refused union and a too-wide snap grid were
 *        each quietly costing a province its shape
 *   6 → Quebec drawn province-wide (multi-use zones incl. Nord-du-Québec)
 *        and Newfoundland and Labrador Crown land (province minus titles)
 *   7 → water is cut out of the green: NL carries OSM water holes, QC
 *        north carries Natural Earth reservoir holes, and the static
 *        overview cuts lakes for every source
 *   8 → Alberta parcels stop carrying "a Public Lands Camping Pass is
 *        required here". They all did, across a Green Area that reaches
 *        the Northwest Territories, for a pass covering a strip down the
 *        Eastern Slopes. The claim now comes from the province's own
 *        outline at the camper's own point, not from the parcel.
 */
const BOUNDARY_DATA_EPOCH = '8';

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
    /*
     * Not derived from the zoom, on purpose. The overview is one answer for
     * the whole coverage area serving every wide zoom there is, so its URL has
     * to be identical at zoom 2 and at zoom 6 — otherwise each zoom step is a
     * different request holding a different sample, which is exactly the
     * popping this tier was rebuilt to stop. See OVERVIEW_BOX.
     */
    params.set('minAreaSqKm', String(OVERVIEW_MIN_AREA_SQ_KM));
  }
  params.set('v', BOUNDARY_DATA_EPOCH);
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
    if (!response.ok) return unavailableBoundaries();

    const data = await response.json();
    if (data?.type !== 'FeatureCollection') return unavailableBoundaries();

    const collection: BoundaryCollection = {
      type: 'FeatureCollection',
      features: Array.isArray(data.features) ? data.features : [],
      meta: data.meta ?? { sources: [] }
    };

    /**
     * An empty answer only counts as an answer if everything was actually
     * asked.
     *
     * The zoomed-out view queries eight government ArcGIS services at once,
     * across a box the size of a continent, from a serverless function with a
     * thirty-second ceiling. A provincial server having a slow afternoon comes
     * back as `available: false` and no parcels — which, combined with the
     * others, produces a perfectly well-formed response describing an empty
     * Alberta. That is the response that was wiping the map.
     *
     * So: no features AND anything went wrong — the server skipped the
     * viewport, or any single source is down — means we learned nothing.
     * Every source up and still nothing is a real, and rare, empty.
     */
    const sources = collection.meta?.sources ?? [];
    const nothingLearned =
      collection.features.length === 0 &&
      (Boolean(collection.meta?.skipped) ||
        sources.length === 0 ||
        sources.some((s) => s.available === false));

    if (nothingLearned) {
      return { ...collection, meta: { ...collection.meta, unavailable: true } };
    }

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
    // A dropped connection says nothing about the ground under the map.
    return unavailableBoundaries();
  }
};
