/**
 * Authoritative public-land boundary sources.
 *
 * ---------------------------------------------------------------------
 * READ THIS BEFORE TRUSTING ANY POLYGON IN HERE
 *
 * Two things people expect from this data that it CANNOT provide:
 *
 * 1. "Absolutely accurate property edges."
 *    Not available from any free national dataset. BLM's own Surface
 *    Management Agency metadata states: "The SMA data do not illustrate
 *    land status ownership pattern boundaries or contain land ownership
 *    attribute details." ParcelMap BC likewise says it "is not the
 *    authoritative source for the legal property boundary; this will
 *    always be the plan of survey."
 *
 *    Survey-grade edges live in county recorder offices, the BLM PLSS
 *    cadastral survey system, and provincial land title registries — not
 *    in a REST service. Near a boundary, assume you may be on private land.
 *
 * 2. "Only land you can actually camp on."
 *    No GIS layer encodes camping legality. It depends on Motor Vehicle
 *    Use Maps, travel management plans, seasonal closures, fire
 *    restrictions and emergency orders — mostly PDFs, not geometry.
 *
 *    The best available proxy is PAD-US `Pub_Access = 'OA'` (Open Access)
 *    combined with excluding designations where dispersed camping is
 *    prohibited. That is a filter, not a guarantee.
 * ---------------------------------------------------------------------
 */

export type EdgeAccuracy = 'generalised' | 'administrative' | 'cadastral_derived';

export type CampingBasisKind =
  | 'explicit_designation'
  | 'open_access_flag'
  | 'agency_policy_inference';

export interface LandSourceSpec {
  id: string;
  label: string;
  attribution: string;
  licence: string;
  jurisdiction: string;
  /**
   * How this source is read.
   *
   * `arcgis` (the default) pages a Feature/MapServer query endpoint with
   * `where`, `outFields` and a bbox, which is what every source here used to
   * be. `geojson` downloads one whole file in a single request.
   *
   * The second exists because MOST OF CANADA HAS NO QUERYABLE SERVICE. The
   * provinces that publish campable Crown land at all publish it as a
   * periodic file, so a fetcher that can only page ArcGIS could never reach
   * them — and that, rather than anything about the code, is why Beacon has
   * been blind everywhere but Ontario and Alberta. A downloaded file is
   * seeded into `public_lands` exactly like a paged one, and from there the
   * map and Beacon both read it without knowing the difference.
   */
  kind?: 'arcgis' | 'geojson';
  url: string;
  where: string;
  outFields: string;
  confidence: 'designated_general_use' | 'managing_agency' | 'managed_zone';
  edgeAccuracy: EdgeAccuracy;
  campingBasisKind: CampingBasisKind;
  /** Server-side page ceiling. Used to detect silent truncation. */
  maxRecordCount: number;
  /** Whole-jurisdiction extent: minLon, minLat, maxLon, maxLat. */
  bbox: [number, number, number, number];
  externalId: (p: any) => string;
  name: (p: any) => string;
  designation: (p: any) => string;
  /** Return null to REJECT. Non-null string is recorded as the basis. */
  campingBasis: (p: any) => string | null;
  stayLimitDays: (p: any) => number | null;
  permit: (p: any) => { required: boolean; name: string | null };
  notes: string;
}

/**
 * Federal designations where dispersed camping is prohibited or so heavily
 * restricted that listing them would be misleading. Conservative by design:
 * when in doubt, exclude.
 */
export const EXCLUDED_DESIGNATIONS =
  /wilderness|national monument|research natural|wildlife refuge|national recreation area|scenic riverway|wild and scenic|national park|historic site|battlefield|memorial|military|proving ground|test range|superfund|conservation area|critical environmental/i;

export const LAND_SOURCES: LandSourceSpec[] = [
  /* ================= UNITED STATES ================= */
  /**
   * ---------------------------------------------------------------------------
   * WHY THERE ARE NOW TWO US FEDERAL SOURCES WHERE THERE WAS ONE
   * ---------------------------------------------------------------------------
   *
   * This registry used to carry a single `blm_sma_national` entry pointed at
   * `.../SurfaceManagementAgency/FeatureServer/0` and filtered
   * `ADMIN_AGENCY_CODE IN ('BLM','FS')`. Both halves of that were broken, and
   * `server/boundaryRoutes.ts` had already found out and fixed it on the live
   * path — the fix was simply never carried back here:
   *
   *   1. THAT LAYER IS A CLIPPED SAMPLE. Its real name is
   *      `SurfaceManagementAgency_Clip`. A query for Moab — ringed by BLM land
   *      — returned nothing. Nationally it held single-digit features.
   *   2. `'FS'` MATCHES NOTHING. The field's values are BIA, BLM, DOD, NPS,
   *      PVT, ST, USFS. Every national forest in the country was excluded by a
   *      two-letter typo.
   *
   * That combination was never merely useless, it was actively dangerous,
   * because `boundaryRoutes.ts` PREFERS seeded data over the live services. A
   * seed run with the old config would have written a nearly-empty United
   * States into `public_lands` and the map would have started drawing that in
   * place of the working live path — public land silently disappearing from
   * the map, which is this app's one forbidden failure.
   *
   * These two entries mirror the endpoints and filters that are verified and
   * in production in `boundaryRoutes.ts`. If you change one, change both.
   */
  {
    // Verified in production: 71,046 features nationally; returns Moab.
    id: 'blm_lands',
    label: 'BLM public land',
    attribution: 'Bureau of Land Management, Geospatial Business Platform',
    licence: 'Public domain (US Government work)',
    jurisdiction: 'US',
    url: 'https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/BLM_Lands/FeatureServer/0/query',
    where: '1=1',
    outFields: '*',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'agency_policy_inference',
    maxRecordCount: 2000,
    bbox: [-125.0, 24.5, -66.9, 49.5],
    externalId: (p) => String(p.OBJECTID ?? p.objectid ?? p.unit_name ?? p.UNIT_NAME),
    name: (p) => p.unit_name || p.UNIT_NAME || 'BLM land',
    designation: () => 'Bureau of Land Management',
    campingBasis: (p) => {
      const unit = String(p.unit_name ?? p.UNIT_NAME ?? '');
      if (EXCLUDED_DESIGNATIONS.test(unit)) return null;
      return 'BLM-administered surface, no excluded designation in the unit name. BLM policy generally permits dispersed camping up to 14 days per 28-day period. Subject to field-office travel management plans and seasonal closures not represented in this dataset.';
    },
    stayLimitDays: () => 14,
    permit: () => ({ required: false, name: null }),
    notes:
      'Authoritative for WHICH AGENCY manages a surface. Explicitly NOT a land-ownership or parcel boundary dataset — BLM states so in its own metadata. Private inholdings are not depicted.'
  },
  {
    // Verified in production: 112 national forests; returns Custer Gallatin.
    id: 'usfs_national_forest',
    label: 'National Forest',
    attribution: 'USDA Forest Service, Enterprise Data Warehouse',
    licence: 'Public domain (US Government work)',
    jurisdiction: 'US',
    url: 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer/1/query',
    where: '1=1',
    outFields: '*',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'agency_policy_inference',
    maxRecordCount: 1000,
    bbox: [-125.0, 24.5, -66.9, 49.5],
    externalId: (p) =>
      String(p.OBJECTID ?? p.objectid ?? p.FORESTORGCODE ?? p.FORESTNAME ?? p.forestname),
    name: (p) => p.FORESTNAME || p.forestname || 'National Forest',
    designation: () => 'US Forest Service',
    campingBasis: (p) => {
      const unit = String(p.FORESTNAME ?? p.forestname ?? '');
      if (EXCLUDED_DESIGNATIONS.test(unit)) return null;
      return 'National Forest System land, no excluded designation in the unit name. USFS policy generally permits dispersed camping up to 14 days. Subject to forest-specific orders and Motor Vehicle Use Maps not represented in this dataset.';
    },
    stayLimitDays: () => 14,
    permit: () => ({ required: false, name: null }),
    notes:
      'Administrative forest boundaries. A national forest boundary encloses private inholdings and wilderness alike; neither is depicted here, so a point inside one of these polygons is not by itself campable ground.'
  },
  /* ================= CANADA =================
   * There is no national Crown land layer. Each province publishes
   * separately, and several publish nothing usable. See COVERAGE_GAPS.
   *
   * ON "GENERAL USE", because it comes up every time someone looks at this:
   *
   * "General Use Area" is a designation in ONE dataset — Ontario's Crown Land
   * Use Policy Atlas. It is not a Canadian concept, and no other province
   * publishes an equivalent. Elsewhere the choice is between a layer of ALL
   * Crown land (which includes leases, dispositions, protected areas and
   * closures, so presenting it as campable would overstate it badly) or
   * nothing at all.
   *
   * crownlandmap.ca is the usual counter-example offered. It aggregates the
   * same provincial open data this registry does, and its own About page says
   * it "does not have data for all provinces yet" and that it "is not an
   * official source of information". It is not a shortcut to national
   * coverage, because national coverage does not currently exist to be had.
   */
  {
    /**
     * BRITISH COLUMBIA — provincial forest, read over WFS rather than ArcGIS.
     *
     * The province is roughly 95% Crown land and was drawing as an empty map,
     * which is this app's one forbidden failure. What it publishes openly is
     * not a campable-land layer and never has been: ParcelMap BC is a cadastral
     * fabric of TITLED parcels and SURVEYED Crown parcels — most BC Crown land
     * is in neither category — and TANTALIS publishes Crown TENURES, which are
     * encumbrances, i.e. exactly the land a camper should not plan on. Both
     * stay rejected in CANDIDATE_SOURCES.
     *
     * FADM_PROV_FOREST is land designated Provincial Forest by Order in Council
     * under the Forest Act. It is Crown land by definition, so it understates
     * BC — badly, and knowingly — rather than overstating it. Same claim, same
     * shape, as the Saskatchewan and Manitoba provincial forests above.
     *
     * `kind: 'geojson'` because DataBC serves WFS, not ArcGIS: one GetFeature
     * returns the whole layer as GeoJSON, which is what the file path already
     * does. Mirrors `bc_provincial_forest` in server/boundaryRoutes.ts, which
     * queries the same feature type per viewport. If you change one, change
     * both.
     */
    id: 'bc_provincial_forest',
    label: 'BC Crown Land (Provincial Forest)',
    attribution: 'Government of British Columbia, DataBC',
    licence: 'Open Government Licence – British Columbia',
    jurisdiction: 'CA-BC',
    kind: 'geojson',
    url:
      'https://openmaps.gov.bc.ca/geo/pub/ows?service=WFS&version=2.0.0&request=GetFeature' +
      '&typeNames=WHSE_ADMIN_BOUNDARIES.FADM_PROV_FOREST&outputFormat=application/json' +
      '&srsName=urn:ogc:def:crs:OGC:1.3:CRS84',
    where: '',
    outFields: '',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'agency_policy_inference',
    maxRecordCount: 0,
    bbox: [-139.1, 48.2, -114.0, 60.05],
    /*
     * The layer's key field has not been read from here, so this takes the
     * first id-shaped property and falls back to the values themselves. An
     * externalId that collided would make the seeder DROP forests as
     * duplicates, which is why the fallback is the whole property bag rather
     * than a name that several blocks could share.
     */
    externalId: (p) => {
      const key = Object.keys(p ?? {}).find((k) => /^objectid$|_id$/i.test(k) && p[k] != null);
      return key ? String(p[key]) : Object.values(p ?? {}).join('|').slice(0, 120);
    },
    name: (p) => p.PROV_FOREST_NAME || p.FOREST_NAME || p.NAME || 'Provincial Forest',
    designation: () => 'British Columbia provincial forest',
    campingBasis: () =>
      'Land designated Provincial Forest under the Forest Act, which is provincial Crown land. ' +
      'British Columbia allows recreational camping on Crown land for up to 14 consecutive days ' +
      'under Land Act permission policy — that is the province\'s general rule, not anything this ' +
      'designation states. Tenured land, parks, recreation sites and areas closed by order sit ' +
      'inside these polygons and are not subtracted from them.',
    stayLimitDays: () => 14,
    permit: () => ({ required: false, name: null }),
    notes:
      'WFS, not ArcGIS: the URL is a whole-layer GetFeature and the response is large — expect a long download, ' +
      'and if the service will not serve it in one piece, download the dataset from the BC Data Catalogue and point ' +
      '`url` at the file on disk, which this fetcher also accepts. Provincial forest is a small fraction of BC Crown ' +
      'land; CA-BC stays in COVERAGE_GAPS for the rest. Endpoint assembled from DataBC WFS conventions and this ' +
      'dataset\'s object name — run `npm run probe -- --source=bc_provincial_forest` before trusting it.'
  },
  {
    /**
     * NEW BRUNSWICK — the extent of Crown land, published as open data by the
     * province. About half of New Brunswick. Mirrors `new_brunswick_crown_land`
     * in server/boundaryRoutes.ts; if you change one, change both.
     */
    id: 'new_brunswick_crown_land',
    label: 'New Brunswick Crown Land',
    attribution: 'Government of New Brunswick, Department of Natural Resources and Energy Development',
    licence: 'Open Government Licence – New Brunswick',
    jurisdiction: 'CA-NB',
    url: 'https://gis-erd-der.gnb.ca/server/rest/services/OpenData/Crown_Lands/MapServer/0/query',
    where: '1=1',
    outFields: '*',
    confidence: 'managing_agency',
    edgeAccuracy: 'cadastral_derived',
    campingBasisKind: 'agency_policy_inference',
    maxRecordCount: 1000,
    bbox: [-69.2, 44.5, -63.6, 48.2],
    externalId: (p) => String(p.OBJECTID ?? p.objectid ?? ''),
    name: () => 'Crown Land',
    designation: () => 'New Brunswick Crown land',
    campingBasis: () =>
      'Provincial Crown land. New Brunswick treats overnight camping as occasional use, which needs no ' +
      'authorisation, and publishes 21 days as the usual limit. That is policy rather than anything this ' +
      'layer states, and leased or licensed Crown land is not subtracted from it.',
    stayLimitDays: () => 21,
    permit: () => ({ required: false, name: null }),
    notes:
      'An ownership layer, not a designation read as a proxy for one — the province publishes where its Crown land IS. ' +
      'Accuracy varies from grant reference plans to registered surveys, per the department.'
  },
  {
    /**
     * NOVA SCOTIA — Crown parcels under the Crown Lands Act, including land the
     * department holds only a partial interest in. Fragmented: roughly a third
     * of the province in thousands of pieces.
     *
     * `stayLimitDays` is null on purpose. Every other province in this registry
     * publishes a number; Nova Scotia publishes what may be done on Crown land
     * without a permit and does not state one, and the figures in circulation
     * come from camping guides. A number invented here would be indistinguish-
     * able, to the app, from one a province actually stands behind.
     */
    id: 'nova_scotia_crown_land',
    label: 'Nova Scotia Crown Land',
    attribution: 'Government of Nova Scotia, Department of Natural Resources and Renewables',
    licence: 'Open Government Licence – Nova Scotia',
    jurisdiction: 'CA-NS',
    url: 'https://nsgiwa.novascotia.ca/arcgis/rest/services/PLAN/PLANCrownLandsWM84V1/MapServer/0/query',
    where: '1=1',
    outFields: '*',
    confidence: 'managing_agency',
    edgeAccuracy: 'cadastral_derived',
    campingBasisKind: 'agency_policy_inference',
    maxRecordCount: 1000,
    bbox: [-66.5, 43.3, -59.6, 47.2],
    externalId: (p) => String(p.OBJECTID ?? p.objectid ?? ''),
    name: () => 'Crown Land',
    designation: () => 'Nova Scotia Crown land',
    campingBasis: () =>
      'Crown land under the administration of the Minister of Natural Resources and Renewables. Nova Scotia ' +
      'permits short recreational stays without a permit; a longer stay needs the department. Wilderness areas ' +
      'and wildlife management areas inside these parcels have their own rules, and the province closes the ' +
      'woods entirely in bad fire seasons.',
    stayLimitDays: () => null,
    permit: () => ({ required: false, name: null }),
    notes:
      'Includes parcels the department holds a partial interest in, so a polygon here is not necessarily wholly provincial.'
  },
  {
    id: 'ontario_clupa_general_use',
    label: 'Ontario Crown Land — General Use Area',
    attribution: "Land Information Ontario, King's Printer for Ontario",
    licence: 'Open Government Licence – Ontario',
    jurisdiction: 'CA-ON',
    url: 'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA/LIO_Open06/MapServer/5/query',
    where: "DESIGNATION_ENG = 'General Use Area'",
    outFields: 'OGF_ID,NAME_ENG,DESIGNATION_ENG,POLICY_IDENT,CATEGORY_ENG',
    confidence: 'designated_general_use',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'explicit_designation',
    maxRecordCount: 5000,
    bbox: [-95.2, 41.6, -74.3, 56.9],
    externalId: (p) => String(p.OGF_ID ?? p.POLICY_IDENT ?? p.NAME_ENG),
    name: (p) => p.NAME_ENG || 'General Use Area',
    designation: (p) => p.DESIGNATION_ENG || 'General Use Area',
    campingBasis: (p) =>
      p.DESIGNATION_ENG === 'General Use Area'
        ? 'Explicitly designated General Use Area in the Ontario Crown Land Use Policy Atlas. Canadian residents may camp free on Crown land up to 21 days per site; non-residents require a permit.'
        : null,
    stayLimitDays: () => 21,
    permit: () => ({ required: false, name: 'Non-residents require a Crown Land Camping Permit' }),
    notes:
      'The ONLY source in this registry with a literal general-use designation. Ontario states CLUPA is "not to be used as a source of protected areas, crown land or private land boundaries." ' +
      'CLUPA covers southern, central and mid-northern Ontario. It stops before the Far North, which is planned under the Far North Act instead — see COVERAGE_GAPS for CA-ON-FARNORTH.'
  },
  {
    /**
     * Alberta's actual campable Crown land, and by far the largest single
     * area in this registry — roughly 339,000 km², about 60% of the province.
     *
     * This was already configured and verified in server/boundaryRoutes.ts,
     * where the live map has been drawing it, but it was never added here — so
     * a full seed produced an Alberta consisting only of the handful of
     * management zones below. GWA_CODE 'GLC_G' is the Green Area; the White
     * Area is deliberately excluded, being the settled southern portion of the
     * province and largely private freehold.
     */
    id: 'alberta_green_area',
    label: 'Alberta Crown Land (Green Area)',
    attribution: 'Government of Alberta',
    licence: 'Open Government Licence – Alberta',
    jurisdiction: 'CA-AB',
    url: 'https://geospatial.alberta.ca/titan/rest/services/boundary/asrd_administrative_area/MapServer/1/query',
    where: "GWA_CODE = 'GLC_G'",
    outFields: 'OBJECTID,GWA_NAME,GWA_CODE',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'agency_policy_inference',
    maxRecordCount: 1000,
    bbox: [-120.1, 48.9, -109.9, 60.1],
    externalId: (p) => String(p.OBJECTID ?? p.GWA_NAME ?? 'green-area'),
    name: () => 'Crown Land (Green Area)',
    designation: () => 'Alberta public land — Green Area',
    campingBasis: () =>
      'Green Area Crown land. Random camping is generally permitted under provincial policy, ' +
      'but this is inferred from that policy rather than from any designation in the data. ' +
      'A Public Lands Camping Pass is required in the Eastern Slopes, and individual areas are closed.',
    stayLimitDays: () => 14,
    permit: () => ({ required: true, name: 'Alberta Public Lands Camping Pass (Eastern Slopes)' }),
    notes:
      'Endpoint and GWA_CODE filter carried over from server/boundaryRoutes.ts, where both were verified against the live service. Campability is a policy inference, not a designation — Alberta publishes no general-use layer.'
  },
  {
    id: 'alberta_pluz',
    label: 'Alberta Public Land Use Zones',
    attribution: 'Government of Alberta',
    licence: 'Open Government Licence – Alberta',
    jurisdiction: 'CA-AB',
    url: 'https://geospatial.alberta.ca/titan/rest/services/base/land_use_management_10tm_nad83_aep/MapServer/1/query',
    where: '1=1',
    outFields: '*',
    confidence: 'managed_zone',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'explicit_designation',
    maxRecordCount: 1000,
    bbox: [-120.1, 48.9, -109.9, 60.1],
    externalId: (p) => String(p.OBJECTID ?? p.PLUZ_NAME),
    name: (p) => p.PLUZ_NAME || 'Public Land Use Zone',
    designation: () => 'Public Land Use Zone (PLUZ)',
    campingBasis: (p) =>
      `Designated Public Land Use Zone (${
        p.PLUZ_NAME ?? 'unnamed'
      }). Random camping permitted subject to zone-specific rules, seasonal closures and, in the Eastern Slopes, a Public Land Camping Pass.`,
    stayLimitDays: () => 14,
    permit: () => ({ required: true, name: 'Alberta Public Land Camping Pass (Eastern Slopes zones)' }),
    notes:
      'Covers DESIGNATED MANAGEMENT ZONES only — not all Alberta Crown land. Large areas of campable Alberta Crown land fall outside any PLUZ and are absent here.'
  },
  {
    /**
     * Saskatchewan's provincial forest — the province's Green Area equivalent.
     *
     * This is admitted on exactly the footing the note above CANDIDATE_SOURCES
     * lays out. It is a layer of LAND, not of what has been done to the land:
     * the polygons are Crown resource land designated as provincial forest
     * under The Forest Resources Management Regulations (F-19.1 Reg 1). The two
     * Saskatchewan leads that stayed rejected — agricultural dispositions and
     * cottage-lot subdivisions — are encumbrances, and mapping either would put
     * someone on a grazing lease.
     *
     * It also lines up with where the province's own camping rule actually
     * applies. Saskatchewan's 21-day free camping allowance is described
     * against Crown resource land north of the provincial forest boundary,
     * which is the boundary this layer draws.
     *
     * WHAT IT DELIBERATELY UNDERSTATES. Crown resource land is roughly 37
     * million hectares and reaches beyond the forest boundary, so a blank
     * southern Saskatchewan is still "no data", never "no public land" — which
     * is why CA-SK stays in COVERAGE_GAPS with a narrowed reason rather than
     * being struck off it.
     */
    id: 'saskatchewan_provincial_forest',
    label: 'Saskatchewan Crown Land (Provincial Forest)',
    attribution: 'Government of Saskatchewan, Ministry of Environment',
    licence: 'Open Government Licence – Saskatchewan',
    jurisdiction: 'CA-SK',
    url: 'https://gis.saskatchewan.ca/arcgis/rest/services/Forestry/MapServer/0/query',
    // The whole layer is the provincial forest, so there is nothing to filter
    // on — and `outFields: '*'` means a field name cannot silently kill this
    // source the way a guessed one would.
    where: '1=1',
    outFields: '*',
    confidence: 'managing_agency',
    // The published layer is the Fire Management branch's display definition,
    // not the surveyed one. Weaker than Alberta's, and labelled as such.
    edgeAccuracy: 'generalised',
    campingBasisKind: 'agency_policy_inference',
    maxRecordCount: 1000,
    bbox: [-110.1, 49.0, -101.3, 60.0],
    externalId: (p) => String(p.OBJECTID ?? p.objectid ?? 'provincial-forest'),
    name: () => 'Crown Land (Provincial Forest)',
    designation: () => 'Saskatchewan provincial forest',
    campingBasis: () =>
      'Crown resource land designated as provincial forest under The Forest Resources ' +
      'Management Regulations. Saskatchewan generally allows recreational camping on ' +
      'unoccupied provincial Crown land free, without a permit or registration, for up to ' +
      '21 consecutive days at one site. That is inferred from provincial policy and not ' +
      'from anything in this layer — the provincial forest also contains protected areas, ' +
      'recreation sites, cottage subdivisions, outfitter allocations and leases where ' +
      'camping is restricted or prohibited, and none of them are subtracted here.',
    stayLimitDays: () => 21,
    permit: () => ({ required: false, name: null }),
    notes:
      'Layer 0 of the Forestry MapServer. Saskatchewan publishes it as the Fire Management ' +
      'and Forest Protection Branch\'s spatial definition of the provincial forest, for ' +
      'display and explicitly NOT as the official version — the legal boundary lives in the ' +
      'regulations. Covers the forested centre and north of the province only; Crown ' +
      'resource land outside the forest boundary is real and is not in here.'
  },
  {
    /**
     * Manitoba's provincial forests — fifteen of them, and a THIN SLICE.
     *
     * Admissible for the same reason Saskatchewan's is: a provincial forest is
     * Crown land, designated under The Forest Act, and Manitoba's own rule is
     * that a resident of Canada may camp free on unoccupied Crown land for up
     * to 21 days at one site unless the site is posted otherwise. It is land,
     * not an encumbrance on land.
     *
     * WHAT MANITOBA PUBLISHES THAT THIS DELIBERATELY DOES NOT USE. The other
     * Crown-land layers on the provincial geoportal are Treaty Land
     * Entitlement selections, TLE acquisitions and Northern Affairs community
     * settlement parcels. Those are allocations — several of them First Nations
     * land selections — and drawing any of them as somewhere to camp would be
     * both wrong and offensive. They are recorded in CANDIDATE_SOURCES as
     * permanently rejected rather than merely unexamined.
     *
     * HOW SMALL THIS IS, SAID PLAINLY. Fifteen forests, about 22,000 km².
     * Manitoba is roughly 650,000 km² and something like three quarters of it
     * is Crown land, most of that in the north where there is no provincial
     * forest designation at all. So this source covers a few percent of the
     * province's campable Crown land and CA-MB stays in COVERAGE_GAPS saying
     * exactly that. A blank Manitoba means we have nothing to show.
     */
    id: 'manitoba_provincial_forest',
    label: 'Manitoba Crown Land (Provincial Forest)',
    attribution: 'Government of Manitoba',
    licence: 'Open Government Licence – Manitoba',
    jurisdiction: 'CA-MB',
    url: 'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/Manitoba_Provincial_Forests___Version_6/FeatureServer/1/query',
    where: '1=1',
    outFields: '*',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'agency_policy_inference',
    maxRecordCount: 2000,
    bbox: [-102.1, 48.9, -88.9, 60.1],
    externalId: (p) => String(p.OBJECTID ?? p.objectid ?? p.FID ?? 'provincial-forest'),
    name: (p) =>
      String(
        p.NAME ?? p.Name ?? p.FOREST_NAME ?? p.PF_NAME ?? p.PROVINCIAL_FOREST ?? 'Provincial Forest'
      ),
    designation: () => 'Manitoba provincial forest',
    campingBasis: () =>
      'Crown land designated as a provincial forest under The Forest Act. Manitoba generally ' +
      'allows a resident of Canada to camp free, without a permit, for up to 21 days at one ' +
      'site on unoccupied Crown land unless it is posted otherwise; non-residents may be ' +
      'treated differently. That is inferred from provincial policy, not from anything in ' +
      'this layer — provincial parks, wildlife management areas, posted closures and leases ' +
      'sit inside and alongside these forests and are not subtracted here.',
    stayLimitDays: () => 21,
    permit: () => ({ required: false, name: null }),
    notes:
      'Fifteen provincial forests, about 22,000 km² — a few percent of Manitoba Crown land, ' +
      'concentrated in the south and centre. Hosted on ArcGIS Online, the same platform as ' +
      'the BLM and PAD-US sources. Absence of a polygon anywhere in Manitoba is "no data", ' +
      'and across most of the province that is emphatically not "no public land".'
  },
  /**
   * QUEBEC — multi-use zones of the public land use plan (PATP), read from a
   * local file because the province publishes no queryable geometry service.
   *
   * WHY THIS IS THE RIGHT LAYER. The PATP (Plan d'affectation du territoire
   * public) is the MRNF's official zoning of the terres du domaine de l'État —
   * roughly 92% of Quebec is public land. Its VOCATION field is the land-use
   * class, and "Utilisation multiple" is the class that means the land is held
   * open for general uses including recreation. It is the closest published
   * proxy for the "territoire public libre" on which the province allows free
   * wild camping: the official rule, quoted in this entry's campingBasis,
   * says camping sauvage is permitted without authorization on numerous
   * portions of the territoire public libre, for temporary stays with mobile
   * gear.
   *
   * WHAT IS DELIBERATELY NOT INCLUDED. Every other VOCATION — Protection,
   * Protection stricte, Privé, Utilisation prioritaire, villégiature — is
   * excluded: those are parks, ecological reserves, private land and priority
   * uses where free camping is not broadly allowed. The dataset's own
   * area field (SUPERFICIE, km²) drops slivers below 1 km².
   *
   * COVERAGE. This source is the SOUTHERN half of the plan — the managed
   * territory south of ~55°N, from the provincial MRNF shapefile. The
   * Nord-du-Québec planning territory (everything from the James Bay coast
   * up to 62°N) is a separate source, `qc_patp_north_multi_use` below, read
   * from the regional Eeyou Istchee Baie-James and Kativik WMS services.
   * Together they cover the whole province.
   *
   * `kind: 'geojson'` + a LOCAL PATH because the PATP is published as a
   * download, not a service: the province's own WMS answers attribute queries
   * with no geometry at all, and no REST layer of the land itself is exposed
   * (see server/boundaryRoutes.ts, Quebec note). The file is produced from
   * the official MRNF shapefile by scripts/convertQcPatp.py, so the source
   * is the province's own data, only pre-filtered.
   */
  {
    id: 'qc_patp_multi_use',
    label: 'Quebec Crown Land (Public Land Use Plan — Multi-Use)',
    attribution: 'Ministère des Ressources naturelles et des Forêts (MRNF), Gouvernement du Québec',
    licence: 'Licence Creative Commons 4.0 (attribution) — Données Québec',
    jurisdiction: 'CA-QC',
    kind: 'geojson',
    url: 'data/qc-patp-campable.json',
    where: '',
    outFields: '*',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'agency_policy_inference',
    maxRecordCount: 2000,
    bbox: [-79.518, 45.379, -61.394, 55.0],
    externalId: (p) => String(p.uuid ?? p.UUID ?? p.OBJECTID ?? 'qc-patm-multi-use'),
    name: (p) => String(p.nom_zone ?? p.NOM_ZONE ?? 'Multi-use public land'),
    designation: () => 'Quebec public land — multi-use zone (PATP)',
    campingBasis: () =>
      'Quebec allows free wild camping (camping sauvage) without a permit on numerous portions ' +
      'of the territoire public libre — the multi-use zones of the public land use plan. The ' +
      'official rule (quebec.ca, Activités permises sur le territoire public) requires the stay ' +
      'to be temporary and the gear to be mobile, and lets municipal regional counties (MRCs) ' +
      'impose their own rules. That basis is inferred from provincial policy, not from anything ' +
      'in this layer — protected zones, private land and priority uses are excluded, but ' +
      'specific closures and local bylaws are not subtracted here.',
    stayLimitDays: () => null,
    permit: () => ({ required: false, name: null }),
    notes:
      'Multi-use (Utilisation multiple) zones of the PATP: 352 polygons, about 192,000 km² of ' +
      'Quebec\'s public land, converted from the official MRNF shapefile by ' +
      'scripts/convertQcPatp.py. Excludes every other vocation (protection, private, ' +
      'priority-use, villégiature). Pairs with qc_patp_north_multi_use for the ' +
      'Nord-du-Québec planning territory. Absence of a polygon is "no data", not "no ' +
      'public land".'
  },
  /**
   * QUEBEC, NORTH — the Nord-du-Québec planning territory, read from the two
   * regional PATP services nobody in this pipeline knew existed until 2026.
   *
   * WHY TWO FILES. The PATP\'s southern shapefile stops at ~55°N. Everything
   * above that — Eeyou Istchee Baie-James (49–55.6°N) and Kativik/Nunavik
   * (55–62°N) — is published by the MRNF as two LIVE ArcGIS MapServers on
   * servicescarto.mrnf.gouv.qc.ca (`PATP_NdQ_EIBJ_WMS`, `PATP_NdQ_Kativik_WMS`),
   * under the MERN "Territoire" folder. Those services have the same VOCATION
   * field and the same "Utilisation multiple" semantics as the south, so the
   * same filter applies. They were discovered by probing the MERN REST
   * directory after the southern pipeline shipped — see the Quebec note in
   * server/boundaryRoutes.ts for the trail.
   *
   * THE GEOMETRY QUIRK. EIBJ layer 3 (the big multi-use zones) answers any
   * geometry query with HTTP 500 unless `maxAllowableOffset` is passed — the
   * raw geometry is malformed server-side and the generaliser heals it.
   * scripts/convertQcPatpNorth.py fetches both services with
   * `maxAllowableOffset=0.01` and writes this file.
   *
   * `kind: 'geojson'` + local path, exactly like the south: the regional
   * services are queryable, but the app\'s server-side fetch pipeline already
   * has the south as a file and mixing one protocol per province is simpler
   * than mixing two.
   */
  {
    id: 'qc_patp_north_multi_use',
    label: 'Quebec Crown Land — Nord-du-Québec (Public Land Use Plan — Multi-Use)',
    attribution: 'Ministère des Ressources naturelles et des Forêts (MRNF), Gouvernement du Québec',
    licence: 'Licence Creative Commons 4.0 (attribution) — Données Québec',
    jurisdiction: 'CA-QC',
    kind: 'geojson',
    url: 'data/qc-patp-north-campable.json',
    where: '',
    outFields: '*',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'agency_policy_inference',
    maxRecordCount: 2000,
    bbox: [-81.5, 49.0, -61.0, 62.4],
    externalId: (p) => String(p.uuid ?? p.UUID ?? p.OBJECTID ?? 'qc-patp-north'),
    name: (p) => String(p.nom_zone ?? p.NOM_ZONE ?? 'Multi-use public land (Nord-du-Québec)'),
    designation: () => 'Quebec public land — multi-use zone, Nord-du-Québec (PATP)',
    campingBasis: () =>
      'Quebec allows free wild camping (camping sauvage) without a permit on numerous portions ' +
      'of the territoire public libre — the multi-use zones of the public land use plan. The ' +
      'official rule (quebec.ca, Activités permises sur le territoire public) requires the stay ' +
      'to be temporary and the gear to be mobile. This northern territory is planned under the ' +
      'Convention de la Baie-James et du Nord québécois and local/regional rules can apply, so ' +
      'the basis is inferred from provincial policy, not from anything in this layer.',
    stayLimitDays: () => null,
    permit: () => ({ required: false, name: null }),
    notes:
      'Multi-use (Utilisation multiple) zones of the Nord-du-Québec planning territory: 3 ' +
      'polygons, about 537,000 km² — Eeyou Istchee Baie-James (2) and Kativik (1) — fetched ' +
      'from the regional PATP MapServers by scripts/convertQcPatpNorth.py. Together with ' +
      'qc_patp_multi_use this maps the multi-use zones of the WHOLE province, roughly ' +
      '730,000 km² of Quebec\'s public land. Absence of a polygon is "no data", not "no ' +
      'public land".'
  },
  /**
   * NEWFOUNDLAND AND LABRADOR — Crown land as the province minus its titles.
   *
   * NL publishes no Crown land layer. It publishes the OPPOSITE: the Land Use
   * Atlas MapServer (LandUseDetails) carries every alienated parcel — Crown
   * titles and applications, federal and municipal land, parks, natural
   * areas, Indigenous land holdings, expropriations, quit claims, hydro
   * lands. NL is ~95% Crown land and free dispersed camping on it is legal
   * unless posted otherwise, so Crown land here is drawn as the province
   * outline minus everything that has been removed from the Crown, computed
   * by scripts/buildNlCrownLand.py.
   *
   * WHY THIS IS ALLOWED WHEN OTHER PROVINCES ARE NOT. The house rule refuses
   * to draw land as campable on the strength of a layer that does not say so.
   * This is the inverse and it is allowed for the same reason NB and NS are:
   * the residual really is Crown land (the province says so — the titles
   * layer IS the record of what is not), and the province\'s camping policy
   * broadly permits it. The subtraction is exhaustive and honest; the caveat
   * in coverage.ts ("edges are approximate") is the camper-facing half.
   *
   * WATER IS DELIBERATELY LEFT IN. Lakes and rivers on Crown land are Crown
   * land; every other mapped province includes its lakes too.
   */
  {
    id: 'nl_crown_land',
    label: 'Newfoundland and Labrador Crown Land (province minus alienated titles)',
    attribution: 'Government of Newfoundland and Labrador, Land Use Atlas',
    licence: 'Open Government Licence — Newfoundland and Labrador',
    jurisdiction: 'CA-NL',
    kind: 'geojson',
    url: 'data/nl-crown-land.json',
    where: '',
    outFields: '*',
    confidence: 'managing_agency',
    edgeAccuracy: 'cadastral_derived',
    campingBasisKind: 'agency_policy_inference',
    maxRecordCount: 2000,
    bbox: [-67.9, 46.6, -52.6, 60.4],
    externalId: (p) => String(p.uuid ?? p.UUID ?? p.OBJECTID ?? 'nl-crown-land'),
    name: (p) => String(p.nom_zone ?? p.name ?? 'Newfoundland and Labrador Crown land'),
    designation: () => 'NL Crown land — province minus alienated titles',
    campingBasis: () =>
      'Newfoundland and Labrador allows free dispersed camping on Crown land unless otherwise ' +
      'posted — no permit for a temporary stay with mobile gear, same class as BC, AB, SK, MB ' +
      'and NB. That basis is provincial policy, not anything in this layer: the polygons are ' +
      'the province minus every alienated title, so a parcel can be drawn Crown land and still ' +
      'sit next to posted private land that is not.',
    stayLimitDays: () => null,
    permit: () => ({ required: false, name: null }),
    notes:
      'Crown land as the province outline minus the LandUseDetails subtraction set (Crown ' +
      'titles 78,896; applications; federal; municipal; parks; ecological/wilderness/wildlife ' +
      'reserves; Indigenous lands; expropriations; quit claims; hydro). About 385,000 km² — the largest ' +
      'single mapped province on the map. Computed by scripts/buildNlCrownLand.py. Water is ' +
      'left in. Absence of a polygon is "no data", not "no Crown land".'
  }
];

/**
 * Documented gaps. Surfaced in the app so the map can grey out regions where
 * absence of a polygon means "we have no data", not "no public land".
 */
/**
 * Researched leads that are NOT wired into the seeder.
 *
 * Deliberately a separate array: nothing here can be seeded by accident. These
 * are the results of actually going looking, recorded in code so the next
 * person starts from here instead of from a search box.
 *
 * THE DISTINCTION THAT DECIDES EVERY ONE OF THESE
 *
 * This registry already carries land on nothing more than "we know who
 * administers it, and that agency's policy generally permits camping" — that
 * is what BLM and Green Area are. So a provincial layer of Crown LAND is
 * admissible on the same footing, with the province's own stated rule as the
 * basis.
 *
 * What is NOT admissible is a layer of what has been done TO Crown land:
 * dispositions, agricultural leases, wildlife management areas, conservation
 * designations. Those are encumbrances. A grazing lease is Crown-owned and
 * emphatically not campable, and mapping one as public land would put someone
 * on a rancher's field.
 *
 * That is the line every candidate below has to be judged against, and it is
 * why several provinces that clearly publish "Crown land" still do not appear
 * in LAND_SOURCES.
 */
export const CANDIDATE_SOURCES: {
  jurisdiction: string;
  region: string;
  url: string;
  /** What it appears to be, from documentation — NOT from a live response. */
  appearsToBe: string;
  /** The question that decides whether it can ever be promoted. */
  mustConfirm: string;
}[] = [
  {
    jurisdiction: 'CA-SK',
    region: 'Saskatchewan',
    url: 'https://gis.saskatchewan.ca/arcgis/rest/services/Agriculture/CrownLand_AG/MapServer',
    appearsToBe:
      'Agricultural Crown land DISPOSITIONS by quarter section. Saskatchewan states a quarter is shown when it contains at least one parcel of agricultural Crown land, and that the whole quarter may not be Crown-owned.',
    mustConfirm:
      'Almost certainly unusable as-is: these are leased agricultural parcels, not open land. Would need a layer of Crown land OWNERSHIP with leases excluded, which does not appear to be published.'
  },
  {
    jurisdiction: 'CA-SK',
    region: 'Saskatchewan',
    url: 'https://gis.saskatchewan.ca/arcgis/rest/services/Planning/MapServer/5',
    appearsToBe:
      '23 recreational SUBDIVISIONS on Crown resource land, outside provincial parks.',
    mustConfirm:
      'Cottage-lot subdivisions are allocated land, not general use. Not a camping layer.'
  },
  {
    jurisdiction: 'CA-MB',
    region: 'Manitoba',
    url: 'https://ouvert.canada.ca/data/dataset/2cbe48f7-6284-7dbe-8d78-1cf5a385764f',
    appearsToBe:
      'Wildlife Management Areas and Special Conservation Areas — designated polygons on Crown land.',
    mustConfirm:
      'Still rejected: restricted designations, the opposite of general use. The question this entry used to ask — "find a plain Crown land layer" — is now partly answered, by Manitoba_Provincial_Forests in LAND_SOURCES. That covers about 22,000 km²; the rest of Manitoba Crown land still has no admissible layer.'
  },
  {
    jurisdiction: 'CA-MB',
    region: 'Manitoba — Treaty Land Entitlement and settlement parcels',
    url: 'https://geoportal.gov.mb.ca/datasets/manitoba::treaty-land-entitlement-sites-in-manitoba/explore',
    appearsToBe:
      'Crown land parcels under Treaty Land Entitlement agreements, TLE acquisitions, and Northern Affairs community flood settlement agreements, all pursuant to The Crown Lands Act.',
    mustConfirm:
      'NEVER USE. Recorded so nobody researches it twice and mistakes "Crown land" in the title for open land. These are allocations, several of them First Nations land selections. Drawing them as places to camp would be wrong on the facts and worse than wrong in what it implies.'
  },
  {
    jurisdiction: 'CA-ON',
    region: 'Ontario — Enhanced Management Areas',
    url: 'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA/LIO_Open06/MapServer/5/query',
    appearsToBe:
      'The other large CLUPA designation, in the same layer this app already queries — so adding it is a one-word change to the `where` clause and looks like free coverage.',
    mustConfirm:
      "Do not make that change. It is exactly the trap this array exists for. An Enhanced Management Area is Crown land, but Ontario's blanket permission to camp does NOT follow the designation the way it does in a General Use Area: each EMA has a reason for the extra management — remote access, tourism, natural heritage, intensive forestry — and its own policy report decides whether recreational use is permitted. That report is prose, not geometry, and it is not in this layer. Mapping EMAs as campable would put an explicit-designation label on land whose designation says the opposite of settled.",
  },
  {
    jurisdiction: 'CA-QC',
    region: 'Quebec',
    url: 'https://www.quebec.ca/en/agriculture-environment-and-natural-resources/occupation-of-public-land/management-of-public-land',
    appearsToBe:
      "Terres du domaine de l'État — roughly 92% of Quebec is public land, administered by MRNF.",
    mustConfirm:
      'RESOLVED, via the download rather than a service: the multi-use (Utilisation multiple) ' +
      'zones of the public land use plan (PATP) are now in LAND_SOURCES as qc_patp_multi_use, ' +
      'converted from the official MRNF shapefile by scripts/convertQcPatp.py. The province ' +
      'still publishes no queryable geometry service — its WMS answers attribute queries with ' +
      'no geometry at all, and no REST layer of the land itself is exposed — so the file path ' +
      'is the one that worked, exactly as fetchGeoJsonFile documents for file-only provinces. ' +
      'What remains unmapped (protected vocations, private land, Nord-du-Québec) is recorded in ' +
      'COVERAGE_GAPS rather than here.'
  },
  {
    jurisdiction: 'CA-BC',
    region: 'British Columbia',
    url: 'https://www2.gov.bc.ca/gov/content/industry/crown-land-water/land-use-planning/spatial-data',
    appearsToBe:
      'BC Geographic Warehouse: ParcelMap BC (cadastral fabric), TANTALIS Crown tenures, protected areas.',
    mustConfirm:
      'Tenures are encumbrances and ParcelMap disclaims legal-boundary authority — both still rejected. The question is now narrower: BC\'s provincial forests ARE drawn (see bc_provincial_forest in LAND_SOURCES, about a fraction of BC Crown land), so what is still wanted is a queryable layer of Crown land OWNERSHIP outside the Forest Act designations. ParcelMap BC\'s OWNER_TYPE = \'Crown Provincial\' is the obvious next candidate and is a trap in its own right: ParcelMap only covers surveyed parcels, so filtering it would draw scattered surveyed lots and imply the unsurveyed Crown land between them is not Crown land.'
  }
];

export const COVERAGE_GAPS: { jurisdiction: string; region: string; reason: string }[] = [
  {
    jurisdiction: 'CA-BC',
    region: 'British Columbia (outside the provincial forests)',
    reason:
      'THINLY COVERED. Land designated Provincial Forest under the Forest Act is now drawn, and it is the only BC layer here: it is Crown land by definition, so it understates the province rather than overstating it. British Columbia is roughly 95% Crown land and provincial forest is a fraction of that, so most of the province still draws blank — including almost everything above the forest designations and along the coast. That blankness is missing data, never missing land. The rest of what BC publishes openly remains inadmissible: ParcelMap BC is a cadastral fabric of titled and surveyed parcels that disclaims legal-boundary authority, and TANTALIS publishes Crown TENURES, which are encumbrances — the opposite of freely campable land.'
  },
  {
    jurisdiction: 'CA-MB',
    region: 'Manitoba (outside the provincial forests)',
    reason:
      'MOSTLY UNMAPPED. The fifteen provincial forests are now drawn — about 22,000 km², concentrated in the south and centre. Manitoba is roughly 650,000 km² and something like three quarters of it is Crown land, most of that in the north with no provincial forest designation and no admissible open layer. The other Crown land Manitoba publishes is Treaty Land Entitlement and settlement parcels, which are allocations and must never be drawn as campable. So across most of this province an empty map means we have nothing to show, not that there is nowhere to camp — and here that gap is the rule rather than the exception.'
  },
  {
    jurisdiction: 'CA-SK',
    region: 'Saskatchewan (outside the provincial forest)',
    reason:
      'PARTIAL COVERAGE. The provincial forest is now mapped, which is the forested centre and north of the province and where Saskatchewan describes its 21-day free camping allowance as applying. Everything south of the forest boundary is not: the Crown land published for that part of the province is agricultural dispositions and cottage subdivisions — leases and allocations, not land anyone may camp on. Saskatchewan administers roughly 37 million hectares of Crown resource land in total, so an empty map south of the forest boundary means we have nothing to show, never that there is nothing there.'
  },
  {
    jurisdiction: 'CA-ON-FARNORTH',
    region: "Ontario's Far North",
    reason:
      'CLUPA — the source of every Ontario polygon this app draws — covers southern, central and mid-northern Ontario and stops there. The Far North is planned separately under the Far North Act, through community-based land use plans led by First Nations, and those are not in the layer we query. Confirmed against the live service: a box from 52.0°N to 55.5°N returns exactly one General Use Area, all of it below 52.5°N. So roughly the northern two fifths of the province draws blank while being overwhelmingly Crown land. That blankness is missing data, not missing land.'
  },
  {
    jurisdiction: 'CA-QC',
    region: 'Quebec (outside the multi-use zones)',
    reason:
      'PARTIAL COVERAGE. The multi-use zones of the public land use plan (PATP) are now drawn ' +
      'from the official MRNF shapefile (scripts/convertQcPatp.py) — 352 polygons, roughly ' +
      '192,000 km², the closest published proxy for the territoire public libre where Quebec ' +
      'allows free wild camping. Quebec is over 90% public land, so this is a large area and ' +
      'a fraction of what is really there: every other vocation (Protection, Protection ' +
      'stricte, Privé, Utilisation prioritaire, villégiature) is excluded by design, and the ' +
      'PATP itself stops around 55°N, so the whole Nord-du-Québec planning territory draws ' +
      'blank. That blankness is missing data, never missing land.'
  },
  {
    jurisdiction: 'CA-PE',
    region: 'Prince Edward Island',
    reason:
      'Little public land, most of the island freehold, and no published general allowance for camping on it that we have found. Not mapped.'
  },
  {
    jurisdiction: 'CA-NL',
    region: 'Newfoundland and Labrador',
    reason:
      'MAPPED. Crown land is drawn as the province outline minus the Land Use Atlas subtraction set (Crown titles, applications, quit claims, parks, ecological/wilderness/wildlife reserves, Indigenous fee-simple lands, federal lands, hydro) — the residual is campable Crown extent, which is most of the province. The remaining gaps are genuine subtractions (water is left in; private towns and the largest townsites sit under the title layers). Computed by scripts/buildNlCrownLand.py.'
  },
  {
    jurisdiction: 'CA-NORTH',
    region: 'Yukon, Northwest Territories, Nunavut',
    reason:
      'OUT OF COVERAGE, not merely unmapped. Territorial land administration is split between territorial and federal jurisdiction with significant Indigenous land claim settlement areas, and none of it is modelled here. The map used to draw the territories inside the coverage outline and then return nothing for them, which reads as "no public land" rather than "no data" — so the outline now stops at 60°N (see src/config/coverage.ts). The provinces get finished before the scope grows again.'
  },
  {
    jurisdiction: 'US-STATE',
    region: 'US state trust and state forest lands',
    reason:
      'NOT MAPPED. PAD-US state trust and state forest parcels were removed. The Pub_Access = OA flag means the public may ENTER — not that anyone may sleep there — and state camping rules vary by state and are in no layer here, so those parcels read as "camp here" when the data said nothing of the kind. Only federal land with a confirmed camping basis (BLM, US Forest Service) is drawn. State lands are out of coverage until a state-by-state camping rule set is modelled.'
  }
];
