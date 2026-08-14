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
  {
    id: 'blm_sma_national',
    label: 'BLM Surface Management Agency (national)',
    attribution: 'Bureau of Land Management, Geospatial Business Platform',
    licence: 'Public domain (US Government work)',
    jurisdiction: 'US',
    url: 'https://services3.arcgis.com/ZyW3beZDqER6f82o/ArcGIS/rest/services/SurfaceManagementAgency/FeatureServer/0/query',
    where: "ADMIN_AGENCY_CODE IN ('BLM','FS')",
    outFields: '*',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'agency_policy_inference',
    maxRecordCount: 2000,
    bbox: [-125.0, 24.5, -66.9, 49.5],
    externalId: (p) =>
      String(p.OBJECTID ?? p.objectid ?? `${p.ADMIN_AGENCY_CODE}:${p.ADMIN_UNIT_NAME}`),
    name: (p) => p.ADMIN_UNIT_NAME || p.ADMIN_AGENCY_CODE || 'Federal land',
    designation: (p) =>
      p.ADMIN_AGENCY_CODE === 'BLM' ? 'Bureau of Land Management'
      : p.ADMIN_AGENCY_CODE === 'FS' ? 'US Forest Service'
      : String(p.ADMIN_AGENCY_CODE ?? 'Federal'),
    campingBasis: (p) => {
      const unit = String(p.ADMIN_UNIT_NAME ?? '');
      if (EXCLUDED_DESIGNATIONS.test(unit)) return null;
      const code = p.ADMIN_AGENCY_CODE;
      if (code === 'BLM') {
        return 'BLM-administered surface, no excluded designation in the unit name. BLM policy generally permits dispersed camping up to 14 days per 28-day period. Subject to field-office travel management plans and seasonal closures not represented in this dataset.';
      }
      if (code === 'FS') {
        return 'National Forest System land, no excluded designation in the unit name. USFS policy generally permits dispersed camping up to 14 days. Subject to forest-specific orders and Motor Vehicle Use Maps not represented in this dataset.';
      }
      return null;
    },
    stayLimitDays: () => 14,
    permit: () => ({ required: false, name: null }),
    notes:
      'Authoritative for WHICH AGENCY manages a surface. Explicitly NOT a land-ownership or parcel boundary dataset — BLM states so in its own metadata. Private inholdings are not depicted.'
  },
  {
    id: 'padus_open_access',
    label: 'PAD-US — Open Access lands',
    attribution: 'USGS Gap Analysis Project, Protected Areas Database of the US',
    licence: 'Public domain (US Government work)',
    jurisdiction: 'US',
    url: 'https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/PADUS_Public_Access/FeatureServer/0/query',
    // OA = Open Access. Excludes RA (Restricted) and XA (Closed).
    where: "Pub_Access = 'OA'",
    outFields: '*',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'open_access_flag',
    maxRecordCount: 2000,
    bbox: [-125.0, 24.5, -66.9, 49.5],
    externalId: (p) => String(p.OBJECTID ?? p.objectid ?? p.BndryName),
    name: (p) => p.BndryName || p.Unit_Nm || 'Public land',
    designation: (p) => p.Des_Tp || p.Mang_Name || 'Open access public land',
    campingBasis: (p) => {
      if (p.Pub_Access !== 'OA') return null;
      const label = `${p.BndryName ?? ''} ${p.Des_Tp ?? ''} ${p.Unit_Nm ?? ''}`;
      if (EXCLUDED_DESIGNATIONS.test(label)) return null;
      return `PAD-US classifies this area as Open Access (Pub_Access = OA) with no excluded designation. Managed by ${
        p.Mang_Name ?? 'a public agency'
      }. Open access means the public may enter; it does not by itself authorise overnight camping.`;
    },
    stayLimitDays: () => 14,
    permit: () => ({ required: false, name: null }),
    notes:
      'PAD-US is the national inventory of protected areas. Pub_Access OA/RA/XA is the only national-scale public-access flag available. Camping still requires local confirmation.'
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
      'The ONLY source in this registry with a literal general-use designation. Ontario states CLUPA is "not to be used as a source of protected areas, crown land or private land boundaries."'
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
      'These are restricted designations, the opposite of general use. Manitoba policy does allow free camping on Crown land for up to 21 days unless posted, so a plain Crown land ownership layer would qualify — locate one before using anything here.'
  },
  {
    jurisdiction: 'CA-QC',
    region: 'Quebec',
    url: 'https://www.quebec.ca/en/agriculture-environment-and-natural-resources/occupation-of-public-land/management-of-public-land',
    appearsToBe:
      "Terres du domaine de l'État — roughly 92% of Quebec is public land, administered by MRNF.",
    mustConfirm:
      'The largest prize in the country by area. No open queryable REST layer of the land itself was found; what is published is land-occupancy raster classification and villégiature planning guidance. Confirm whether Données Québec exposes a vector service.'
  },
  {
    jurisdiction: 'CA-BC',
    region: 'British Columbia',
    url: 'https://www2.gov.bc.ca/gov/content/industry/crown-land-water/land-use-planning/spatial-data',
    appearsToBe:
      'BC Geographic Warehouse: ParcelMap BC (cadastral fabric), TANTALIS Crown tenures, protected areas.',
    mustConfirm:
      'Tenures are encumbrances and ParcelMap disclaims legal-boundary authority. Confirm whether the BCGW publishes Crown land ownership as a queryable layer rather than a download.'
  }
];

export const COVERAGE_GAPS: { jurisdiction: string; region: string; reason: string }[] = [
  {
    jurisdiction: 'CA-BC',
    region: 'British Columbia',
    reason:
      'No open layer of campable Crown land. ParcelMap BC is a cadastral fabric (and disclaims legal-boundary authority); TANTALIS publishes Crown TENURES, which are encumbrances — the opposite of freely campable land.'
  },
  {
    jurisdiction: 'CA-MB',
    region: 'Manitoba',
    reason: 'Manitoba operates a geoportal, but no confirmed open REST layer delineating campable Crown land.'
  },
  {
    jurisdiction: 'CA-SK',
    region: 'Saskatchewan',
    reason:
      'Crown land is administered through the Saskatchewan Land Information Services portal and the Crown land listings are sale/lease dispositions, not a layer of land open to camping. No confirmed open REST endpoint. Recorded here because it was previously absent from this list entirely — an unlisted gap is indistinguishable from covered ground, which is the failure this table exists to prevent.'
  },
  {
    jurisdiction: 'CA-QC',
    region: 'Quebec',
    reason:
      "Terres du domaine de l'État are administered via MRNF; no confirmed open REST endpoint for general-use camping areas."
  },
  {
    jurisdiction: 'CA-ATL',
    region: 'Atlantic Canada (NB, NS, PE, NL)',
    reason:
      'Provincial Crown land datasets are published as periodic file downloads rather than queryable services.'
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
      'PAD-US is now queried live as well as seeded, so state forests, state trust ' +
      'parcels, national grasslands and county holdings appear wherever USGS has ' +
      'populated Pub_Access = OA. That is most of the country and not all of it, and ' +
      'the flag means the public may ENTER — not that anyone may sleep there. State ' +
      'camping rules still vary by state and are in no layer here, so a PAD-US parcel ' +
      'is the weakest kind of lead this app produces.'
  }
];