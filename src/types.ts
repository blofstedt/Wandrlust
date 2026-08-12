export type LandType = 'blm' | 'usfs' | 'state_forest' | 'dispersed' | 'crown_land';
export type RoadAccess = 'paved' | 'gravel' | 'high_clearance' | '4x4_only';
export type ToiletType = 'none' | 'vault' | 'flush' | 'pack_out';
export type WaterType = 'none' | 'potable' | 'natural_stream' | 'seasonal_creek';
export type ShadeType = 'full' | 'partial' | 'none';
export type CampsiteSource = 'verified' | 'overpass' | 'user_submitted';

export interface CellSignal {
  verizon: number; // 0 to 5 bars
  att: number;
  tmobile: number;
}

/**
 * What is known about a site's facilities — and nothing more.
 *
 * EVERY FIELD IS OPTIONAL, AND THAT IS THE POINT. Absent means "nobody has
 * recorded this", which is the true state for most dispersed sites. It does
 * not mean "no", and the UI must never render it as one.
 *
 * These were previously all required, so every site had to carry a value
 * whether or not one was known. That produced a dataset where all 21 curated
 * sites had carrier signal bars nobody had measured, an identical 14-day stay
 * limit, and a star rating out of zero reviews. A camper deciding whether they
 * can get a trailer down a road has no way to tell an observation from a
 * filled-in blank, which is the failure this app exists to avoid.
 */
export interface CampsiteAmenities {
  water?: WaterType;
  toilet?: ToiletType;
  roadAccess?: RoadAccess;
  cellSignal?: CellSignal;
  maxRvLengthFeet?: number;
  fireRing?: boolean;
  petFriendly?: boolean;
  trashService?: boolean;
  shade?: ShadeType;
  stayLimitDays?: number;
  isFree?: boolean;
  permitRequired?: boolean;
}

export interface CamperReview {
  id: string;
  author: string;
  date: string;
  rating: number; // 1-5
  comment: string;
  vehicleType?: string;
}

export interface Campsite {
  id: string;
  name: string;
  landType: LandType;
  /** e.g. "Bureau of Land Management", "Bridger-Teton NF" */
  landManager: string;
  latitude: number;
  longitude: number;
  elevationFt?: number;
  address: {
    nearestCity: string;
    stateProvince: string;
    country: string;
    description?: string;
  };
  description: string;
  amenities: CampsiteAmenities;
  images: string[];
  reviews: CamperReview[];
  rating: number; // average
  reviewCount: number;
  source: CampsiteSource;
  savedOffline?: boolean;
  /** Live occupancy, when the server has reported one. */
  capacityStatus?: 'empty' | 'light' | 'busy' | 'full' | 'unknown';

  /**
   * A pin only campers who have earned the tier can see exactly.
   *
   * `isApproximate` means the SERVER deliberately rounded this position to
   * roughly 2 km before sending it. Drawing such a pin as though it were
   * surveyed is a lie about where the site is, so anything rendering a
   * campsite has to check this and say so.
   */
  isStealth?: boolean;
  isApproximate?: boolean;

  /** Where a user's own submission has got to. Absent for anything else. */
  submissionState?: SubmissionState;
  /** True when the signed-in camper is the one who submitted this. */
  submittedByMe?: boolean;
}

/**
 * How far a camper's own submitted spot has travelled.
 *
 * `local_only` is the honest name for what every submission used to be: saved
 * to this browser and shared with nobody. It is still what happens when you
 * submit while signed out, and the UI has to say so rather than implying the
 * spot has been contributed.
 */
export type SubmissionState = 'local_only' | 'pending_review' | 'published' | 'rejected';

export interface GeocodedLocation {
  displayName: string;
  city: string;
  stateProvince: string;
  country: string;
  lat: number;
  lon: number;
  /** [south, north, west, east] */
  boundingBox?: [number, number, number, number];
}

export interface FilterState {
  searchQuery: string;
  landTypes: LandType[];
  waterOnly: boolean;
  toiletOnly: boolean;
  cellSignalOnly: boolean;
  petFriendlyOnly: boolean;
  rigLengthMinFt: number;
  roadAccessMax: RoadAccess | 'all';
  maxDistanceMiles: number;
  sortBy: 'distance' | 'rating' | 'name' | 'stay_limit';
}

export interface OfflineRegion {
  id: string;
  name: string;
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  center: [number, number];
  zoomMin: number;
  zoomMax: number;
  tileCount: number;
  sizeMb: number;
  downloadedAt: string;
  campsiteCount: number;
}

export type MapTileLayer = 'topo' | 'satellite' | 'street';

export type AppView = 'map' | 'list' | 'saved';

/* ------------------------------------------------------------------ *
 * Cell coverage
 *
 * An APPROXIMATION, and typed so it cannot pretend otherwise. `bars` is
 * optional on every carrier because "nobody has data for T-Mobile here" and
 * "T-Mobile has no signal here" are different facts and a camper deciding
 * whether they can call for help must not have them merged.
 *
 * `basis` is the sentence shown under the bars saying how the number was
 * arrived at. Nothing renders coverage without it.
 * ------------------------------------------------------------------ */

export type CarrierId = 'verizon' | 'att' | 'tmobile' | 'rogers' | 'telus' | 'bell';

/** The word a camper reads. Bars are the drawing; this is the answer. */
export type SignalStrength = 'strong' | 'good' | 'weak' | 'none';

/**
 * Which generation the nearest transmitter serves.
 *
 * Absent whenever nobody recorded it, which is most masts. It is never
 * inferred from the carrier or the era — an untagged mast gets no label.
 */
export type CellTechnology = '5G' | '4G LTE' | '3G' | '2G';

/**
 * One transmitter, positioned.
 *
 * `carrier` is absent when the register did not say whose it is — the common
 * case for a surveyed OpenStreetMap mast. Such a tower is real, is drawn on
 * the map, and still answers "is there anything up here at all", but it is
 * never allowed to fill in a named carrier's row.
 */
export interface CellTower {
  latitude: number;
  longitude: number;
  carrier?: CarrierId;
  /** Whatever the register called the operator, when it named one. */
  operator?: string;
  technology?: CellTechnology;
  /** Straight-line km from the point that was asked about. */
  distanceKm: number;
  source: 'osm' | 'opencellid';
}

export interface CarrierCoverage {
  carrier: CarrierId;
  label: string;
  /** 0–5, approximated from the source below. Absent means "no data". */
  bars?: number;
  /** The same estimate in words. Present exactly when `bars` is. */
  strength?: SignalStrength;
  /** The nearest tower's generation, when the register recorded one. */
  technology?: CellTechnology;
  /** Straight-line km to the nearest recorded tower, when that is the basis. */
  nearestTowerKm?: number;
  /** How many towers the source knows about within the search radius. */
  towerCount?: number;
}

/**
 * The answer for a camper who does not care whose tower it is.
 *
 * Built from every transmitter found, attributed or not, because "can I call
 * for help from here" is the question that actually decides a trip and most
 * surveyed masts name no operator.
 */
export interface OverallCoverage {
  strength: SignalStrength;
  bars: number;
  technology?: CellTechnology;
  nearestTowerKm: number;
  towerCount: number;
}

export interface CellCoverage {
  ok: boolean;
  /** Who publishes the underlying data, named so a camper can judge it. */
  source: string;
  /** One sentence on how `bars` was derived. Always rendered with the bars. */
  basis: string;
  carriers: CarrierCoverage[];
  /** Any-network verdict, absent when no transmitter was found at all. */
  overall?: OverallCoverage;
  /** The transmitters behind the estimate, nearest first. */
  towers?: CellTower[];
  /** Why there is nothing to show, when `ok` is false. */
  note?: string;
}

/* ------------------------------------------------------------------ *
 * Destinations and navigation
 * ------------------------------------------------------------------ */

/**
 * What the boundary layer knows about the land under a tapped point.
 *
 * Populated from the polygon already loaded in the browser — no extra request
 * — and absent whenever no parcel covers the point, which means "no data
 * here", never "not public land".
 */
export interface DestinationLand {
  name: string;
  designation: string;
  attribution?: string;
  stayLimitDays?: number;
  permitRequired?: boolean;
  permitName?: string;
  permitUrl?: string;
  fireBanActive?: boolean;
  campfirePolicy?: string;
}

/**
 * Somewhere the user has picked on the map.
 *
 * Either a point they tapped (`campsite` absent) or a pin they selected. Both
 * can be navigated to, and both get the same conditions treatment.
 */
export interface MapDestination {
  latitude: number;
  longitude: number;
  /** Set when the destination is an existing pin rather than a dropped one. */
  campsite?: Campsite;
  land?: DestinationLand;
}

export type LegalDocKind = 'privacy_policy' | 'terms_of_service' | 'safety_disclaimer';

/* ------------------------------------------------------------------ *
 * Points and tiers
 *
 * Points are earned, never sold. The reward for earning them is the tier
 * they move you into — see src/config/tiers.ts for the ladder itself.
 * ------------------------------------------------------------------ */

export type TrustTier = 'tourist' | 'camper' | 'scout' | 'trailblazer' | 'nomad';

export interface TierDefinition {
  id: TrustTier;
  /** 1–5, ascending. Mirrors tier_rank() in SQL. */
  rank: number;
  label: string;
  /** Trust score at which this tier begins. */
  minScore: number;
  blurb: string;
  /** Trophy fill. */
  color: string;
  /** Second stop for the shine, and the gradient's end on the top tier. */
  colorSoft: string;
  /** Tailwind classes for the tier chip. Full strings — Tailwind scans text. */
  ring: string;
  /** The top tier gets a two-colour trophy instead of a metal. */
  isAurora?: boolean;
}

/* ------------------------------------------------------------------ *
 * Field guide
 *
 * The content lives in src/data/campingGuide.ts and is rendered by
 * CampingGuideModal. It is a summary of published agency rules, not the
 * rules themselves — every section carries a `source` so a reader can go
 * check the original, because regulations change and vary by district.
 * ------------------------------------------------------------------ */

export type GuideAccent = 'amber' | 'emerald' | 'cyan' | 'rose' | 'violet' | 'sky';

export interface GuideLink {
  label: string;
  href: string;
}

/** One rule. `term` is the bolded lead-in; entries without one read as prose. */
export interface GuideEntry {
  term?: string;
  text: string;
}

export interface GuideSubsection {
  id: string;
  title: string;
  entries: GuideEntry[];
  /** A muted caveat under the entries — usually "this varies, go check". */
  caveat?: string;
}

export interface GuideSection {
  id: string;
  title: string;
  summary: string;
  /** Key into ICONS in CampingGuideModal. Keeps this file free of React. */
  icon: string;
  accent: GuideAccent;
  /** Where these rules apply, e.g. "Alberta, Canada". Omit if universal. */
  scope?: string;
  /** Who publishes the rules this section summarises. */
  source?: string;
  subsections: GuideSubsection[];
  links?: GuideLink[];
}
/* ---------------------------------------------------------------------
 * NEARBY FACILITIES
 *
 * A toilet, tap or fuel pump somebody mapped in OpenStreetMap near a spot.
 * See `services/nearbyAmenityService.ts` for what its coverage does and does
 * not mean — the short version is that finding nothing is an absence of
 * survey, never an absence of facilities.
 * ------------------------------------------------------------------ */

/**
 * `road` is the odd one out and deliberately so.
 *
 * It is not a facility somebody built; it is the nearest driveable track,
 * looked up only for a point sitting in public land, to answer "could I get
 * a vehicle anywhere near here?". It rides in the facility list because it
 * behaves identically once found — a chip on the pin, framed and routed when
 * tapped — but it is never a claim that the road reaches a place to camp.
 */
export type NearbyFacilityKind =
  | 'toilet' | 'shower' | 'water' | 'dump' | 'fuel' | 'groceries'
  | 'trail' | 'fishing' | 'boat' | 'waste' | 'road';

export interface NearbyFacility {
  id: string;
  kind: NearbyFacilityKind;
  /** Only when OSM carries one; most pit toilets are nameless. */
  name?: string;
  latitude: number;
  longitude: number;
  /** Straight-line distance from the spot, in km, to one decimal. */
  distanceKm: number;
  /** Undefined when nobody recorded whether it costs anything. */
  fee?: boolean;
}

/* ------------------------------------------------------------------ */
/* Beacon                                                              */
/* ------------------------------------------------------------------ */

/**
 * How much is actually known about a possible overnight spot.
 *
 * These are EVIDENCE labels, not confidence labels, and the distinction is the
 * whole design. `lead` means public map data suggested a place and nobody has
 * ever been there; it is the ceiling for anything an algorithm produces, and
 * the database enforces that rather than trusting this UI to. Only a camper
 * who actually slept somewhere can move a spot up, and it takes two separate
 * campers to reach `confirmed`.
 *
 * There is deliberately no tier meaning "we are sure". Nothing here can be.
 */
export type BeaconTier = 'lead' | 'reported' | 'confirmed' | 'withdrawn';

/** Which candidate generator found it — public land, or the edge of a town. */
export type BeaconGenerator = 'public_land' | 'urban';

/**
 * What the street-level sign check found.
 *
 * `unknown` is NOT `clear`. It means either that no Mapillary token is
 * configured or that nobody has driven this road with a camera, and treating
 * the two as the same is how an app tells somebody a permit-only lot is fine.
 */
export type BeaconSignEvidence = 'unknown' | 'clear' | 'restricted';

/** What a camper found when they got there. Only `good` is good news. */
export type BeaconOutcome =
  | 'good' | 'ticketed' | 'asked_to_leave' | 'posted_no_parking' | 'gone';

export interface BeaconSpot {
  id: string;
  latitude: number;
  longitude: number;
  tier: BeaconTier;
  generator: BeaconGenerator;
  /** What the place is, in a camper's words: "Passing place", "Rest area". */
  label: string;
  /** Why we think you might be allowed to stay. Shown verbatim, never edited. */
  landBasis?: string;
  signEvidence: BeaconSignEvidence;
  /** How many separate campers have vouched for it. Zero for every lead. */
  verifyCount: number;
  /** Rule score plus the learned model score. Higher is a better guess. */
  score: number;
  region: string;
  metresAway?: number;
}

/** What a Beacon scan came back with, caveat included. */
export interface BeaconQueryResult {
  ok: boolean;
  spots: BeaconSpot[];
  /** True when this was answered from ground somebody already swept — free. */
  cached: boolean;
  /** Beacons left in the current 12-hour window, when the server said. */
  remaining?: number;
  resetsAt?: string;
  radiusScannedM?: number;
  sources?: Record<string, string>;
  /** Always present. Travels with the data so it cannot be rendered without. */
  disclaimer: string;
  note?: string;
  signageNote?: string;
}

/** Where a camper is in the four-hour dwell, as the server sees it. */
export interface BeaconDwellState {
  ok: boolean;
  distanceM?: number;
  arrivedAt?: string;
  dwellMinutes: number;
  /** Four contiguous hours of endpoints inside the fence. */
  ready: boolean;
  message?: string;
}

/** The boolean form a camper fills in when vouching for a spot. */
export interface BeaconVerificationAnswers {
  signs_restricted: boolean;
  ground_flat: boolean;
  quiet_overnight: boolean;
  note?: string;
}

/** What the ranking model has learned, in a shape worth showing a person. */
export interface BeaconModelSummary {
  region: string;
  stays_recorded: number;
  reports_recorded: number;
  observations_here: number;
  trusts_most: string[];
  trusts_least: string[];
}
