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
      'Territorial land administration is split between territorial and federal jurisdiction with significant Indigenous land claim settlement areas. Not modelled; misrepresenting these boundaries would be worse than showing nothing.'
  },
  {
    jurisdiction: 'US-STATE',
    region: 'US state trust and state forest lands',
    reason:
      'State-level camping rules vary by state and are not in the federal SMA layer. PAD-US includes some state lands where Pub_Access is populated, but coverage is uneven.'
  }
];
