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
  addre
ss: {
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
  /**
   * The account that put this spot on the map, when a camper did.
   *
   * Absent on the curated sites — nobody submitted those — and absent on a
   * spot that only exists on this device. The name behind the id is looked up
   * separately (`fetchSpotAuthor`); the id itself is not shown to anybody.
   */
  submittedBy?: string;
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
  /** [south, north, west, east
] */
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
  /**
   * Tiles this region actually HOLDS, not the number it set out to fetch.
   *
   * These were the same number until a download that could not store anything
   * still recorded the full count and drew a green tick — the app promising
   * imagery for ground it had none of, to a camper who by then had no signal
   * to find out otherwise.
   */
  tileCount: number;
  /**
   * What it asked for. Equal to `tileCount` on a clean download.
   *
   * Optional because regions already sitting on a phone were written before
   * this existed. Absent means "not recorded", which is not the same as zero.
   */
  tilesRequested?: number;
  /**
   * False when tiles were missed — storage filled, or the network dropped.
   * Absent on regions saved by an older build, whose real state is unknown.
   */
  complete?: boolean;
  sizeMb: number;
  downloadedAt: string;
  campsiteCount: number;
}

export type MapTileLayer = 'topo' | 'satellite' | 'street';

export type AppView = 'map' | 'list' | 'saved' | 'tools';

/**
 * How the facility lookup for the switched-on layers is going.
 *
 * Five states and not one boolean, because four of them look identical on a
 * map — an empty screen — and mean completely different things. See the
 * sentence each one gets in `facilityNotice`.
 */
export type FacilityLookupState =
  | { status: 'idle' }
  | { status: 'zoomed-out' }
  | { status: 'l
oading' }
  | { status: 'failed' }
  | { status: 'done'; count: number; truncated: boolean };

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
  /**
   * Which boundary source this parcel came from — `blm_lands`,
   * `ontario_clupa_general_use` and
 so on.
   *
   * Carried so the app can fall back to the rule that agency publishes for
   * this whole class of land when the parcel's own record is silent, which is
   * almost always. See `src/config/landRules.ts`.
   */
  sourceId?: string;
  attribution?: string;
  stayLimitDays?: number;
  /**
   * How far you have to move once the stay limit is up, where the manager has
   * said. "14 days" on its own is only half the rule — the other half is that
   * moving 200 m down the same track does not restart it.
   */
  moveDistanceKm?: number;
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
  /** Tailwind classes for the tier chip. Full strings — Tailwin
d scans text. */
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
 * It is 
not a facility somebody built; it is the nearest driveable track,
 * looked up only for a point sitting in public land, to answer "could I get
 * a vehicle anywhere near here?". It rides in the facility list because it
 * behaves identically once found — a chip on the pin, framed and routed when
 * tapped — but it is never a claim that the road reaches a place to camp.
 */
export type FacilityKind =
  | 'toilet' | 'water' | 'shower' | 'dump' | 'fuel' | 'propane' | 'laundry'
  | 'groceries' | 'waste' | 'air'
  | 'trail' | 'fishing' | 'boat' | 'road';

/**
 * The old name, kept because it reads better at the call sites that ask about
 * ONE spot's surroundings ("the nearby facilities") than a bare `FacilityKind`
 * would. Same type; `config/facilities.ts` is the table behind both.
 */
export type NearbyFacilityKind = FacilityKind;

export interface NearbyFacility {
  id: string;
  kind: FacilityKind;
  /** Only when OSM carries one; most pit toilets are nameless. */
  name?: string;
  latitude: number;
  longitude: number;
  /** Straight-line distance from the spot, in km, to one decimal. */
  distanceKm: number;
  /** Undefined when nobody recorded whether it costs anything. */
  fee?: boolean;
  /**
   * The shape of the thing, when it HAS a shape — `[lat, lon]` pairs.
   *
   * Only the road carries one. A toilet is a point and a point is the whole
   * truth about it, but "there is a road 300 m away" is a claim about a line,
   * and tapping that chip takes the camera out to draw the line rather than
   * dropping a dot on the single nearest vertex of it.
   */
  line?: [number, number][];
}

/**
 * A facility as the MAP LAYER draws it, from either source or both.
 *
 * `NearbyFacility` above answers "what is near this one spot", is capped at
 * the nearest of each kind, and only ever comes from OpenStreetMap. This is
 * the other question — "show me every toilet in view" — and it has to carry
 * where each one came from, because that is the difference between "a

 * volunteer mapped this years ago" and "a camper stood here last week".
 *
 * A pin can be BOTH. When an OSM node and a camper's submission of the same
 * kind land within a few dozen metres, they are drawn as one pin wearing both
 * facts rather than as two pins claiming two toilets — but neither record is
 * thrown away, because hiding a real one is the failure that matters. Same
 * doctrine as `utils/mergeCampsites.ts`.
 */
export interface MapFacility {
  /** Stable across refetches: the OSM id, or the `pois` row id. */
  id: string;
  kind: FacilityKind;
  /** Absent on most pit toilets, and that is normal. Never invented. */
  name?: string;
  latitude: number;
  longitude: number;
  /** Somebody mapped this in OpenStreetMap. */
  fromOsm: boolean;
  /** The `pois` row id, when a camper added or confirmed it. */
  poiId?: string;
  /**
   * Net confirmations from campers. Zero means one person said so and nobody
   * has agreed yet — NOT that anybody disagreed.
   */
  confirmations: number;
  /** Whatever the camper typed. Never generated. */
  detail?: string;
  /** Undefined when nobody recorded whether it costs anything. */
  fee?: boolean;
  /**
   * What campers have written about finding it — "behind the yellow wall, at
   * the back". Attached to a `pois` row or to an OSM node id; see
   * `supabase_migration_25_poi_notes.sql`.
   *
   * Directions, not a review. A note is one camper's words and is attributed
   * as such; it never changes the pin's standing, because saying where a thing
   * is is not the same as saying you found it there today.
   */
  notes?: FacilityNote[];
}

/** One camper's note on one facility. */
export interface FacilityNote {
  id: string;
  body: string;
  authorName: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Beacon                                                              */
/* ------------------------------------------------------------------ */

/**
 *
 How much is actually known about a possible overnight spot.
 *
 * These are EVIDENCE labels, not confidence labels, and the distinction is the
 * whole design. `lead` means public map data suggested a place and nobody has
 * ever been there; it is the ceiling for anything an algorithm produces, and
 * the database enforces that rather than trusting this UI to. Only a camper
 * who actually went there can move a spot up the ladder.
 *
 * The ladder is `lead → reported → corroborated → confirmed`, and the camper
 * counts that separate the rungs live in ONE place — `BEACON_TIER_STEPS` in
 * `config/beacon.ts`, mirrored by `beacon_tier_for()` in migration 14. Change
 * them there, never here.
 *
 * `flagged` is not a rung. It is what happens when somebody got a knock on the
 * window: the spot turns red and STAYS ON THE MAP, because a spot that quietly
 * disappears is a spot the next camper rediscovers on their own and parks at
 * anyway. `withdrawn` is reserved for a place that is no longer a place at all
 * — gated, built on, gone.
 *
 * There is deliberately no tier meaning "we are sure". Nothing here can be.
 */
export type BeaconTier =
  | 'lead' | 'reported' | 'corroborated' | 'confirmed' | 'flagged' | 'withdrawn';

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
  tier:
 BeaconTier;
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
  /**
   * The knock, if there was one.
   *
   * Present only on a `flagged` spot. The comment is the reporting camper's
   * own words and is shown verbatim — it is the whole reason the pin stays on
   * the map instead of vanishing.
   */
  knock?: {
    reportedAt: string;
    /** What happened, in the reporter's words. May be absent. */
    comment?: string;
    /** How many separate campers have reported being moved on here. */
    count: number;
  };
  /**
   * What campers who stayed here said, averaged.
   *
   * Every field is optional and stays undefined until somebody actually
   * answered that question — an unanswered slider must never read as a zero.
   * See `SpotVisitReport` for what each scale means.
   */
  conditions?: SpotConditions;
}

/* ------------------------------------------------------------------ */
/* Taking a spot back down                                             */
/* ------------------------------------------------------------------ */

/**
 * Whether the person looking at a spot is allowed to remove it.
 *
 * One shape for both kinds of spot — a campsite submission and a Beacon pin —
 * because it is one rule: you may take down what you added, for exactly as
 * long as it is still only yours. As soon as anybody else reviews it, checks
 * in, saves it or reports on it, it is on their map too and deleting it would
 * throw away their work, not yours.
 *
 * Read BEFORE the button is drawn, never after it is pressed. A remove bu
tton
 * that turns out to be refused is worse than no button at all: the camper has
 * already decided the spot is gone by the time they read the error.
 */
export interface SpotRemovalState {
  /**
   * Whether the server actually answered the question.
   *
   * FALSE MEANS EVERY OTHER FIELD HERE IS A DEFAULT, NOT A FACT. The lookup
   * failed — no connection, or a database that has not had the migration run
   * against it — and nothing below was learned.
   *
   * This exists because without it a failure was indistinguishable from
   * `exists: false`, which the campsite sheet reads as "there is no server row,
   * so this is a device-only copy and yours to delete freely". A camper on a
   * flaky connection was therefore offered a Remove button on somebody else's
   * published spot, and only found out it was refused after they had already
   * decided the spot was gone — the exact thing asking first was meant to
   * prevent.
   */
  asked: boolean;
  /**
   * Whether the server has a row for this spot at all.
   *
   * `false` is the normal state of a spot added with no account or no signal.
   * That copy lives on the phone and only the phone, so removing it is between
   * the camper and their own device and needs nobody's permission.
   *
   * Only meaningful when `asked` is true.
   */
  exists: boolean;
  /** The signed-in camper is the one who added it. */
  mine: boolean;
  /** Theirs AND untouched by anybody else. The only state that allows removal. */
  removable: boolean;
  /** How many other campers have engaged with it. Zero whenever removable. */
  others: number;
  /** Plain English, from the server, for why it can or cannot go. May be empty. */
  message: string;
}

/* ------------------------------------------------------------------ */
/* Spot reports — what a camper says after being somewhere              */
/* ------------------------------------------------------------------ */

/**
 * The answer scales.
 *
 * Every one of these is a smal
l integer with named stops rather than a
 * free-running 0-100, for two reasons. A continuous slider is hard to land on
 * a phone with one thumb in the dark, and it invents precision nobody has —
 * "crowding 63" means nothing, "half full" means something.
 *
 * `undefined` is a first-class value everywhere here and means NOT ANSWERED.
 * It is never coerced to zero on the way into the database, because "empty"
 * and "nobody said" are different facts and this app does not blur those.
 */
export type SpotScale = 0 | 1 | 2 | 3 | 4;

/** Averaged answers across everyone who has reported on a spot. */
export interface SpotConditions {
  crowding?: number;
  rating?: number;
  view?: number;
  maxRig?: number;
  roadAccess?: number;
  levelGround?: number;
  shade?: number;
  nightLight?: number;
  /** How many separate visits these averages are built from. */
  sampleSize: number;
  /** Cell bars at the moment of submission, averaged, when anyone recorded it. */
  cellBars?: number;
}

/**
 * One camper's report on one spot.
 *
 * Filled in by the report sheet and written by `beacon_submit_visit`. Nothing
 * here is required except the proof fields — a camper in a hurry can answer
 * two questions and submit, and every question they skipped stays unknown
 * rather than being guessed at.
 */
export interface SpotVisitReport {
  /** 0 empty → 4 packed. */
  crowding?: SpotScale;
  /** 0 poor → 4 excellent. The camper's overall verdict. */
  rating?: SpotScale;
  /** 0 nothing to look at → 4 stunning. */
  view?: SpotScale;
  /** 0 tent only → 4 big rig, 40 ft and up. */
  maxRig?: SpotScale;
  /** 0 paved → 3 4x4 only. */
  roadAccess?: SpotScale;
  /** 0 sloped → 2 dead flat. */
  levelGround?: SpotScale;
  /** 0 full sun → 2 mostly shaded. */
  shade?: SpotScale;
  /** 0 pitch dark → 3 lit up all night. */
  nightLight?: SpotScale;

  /**
   * Amenities the camper knows about that our own POI sweep missed.
   *
   * Tri-state on purpose. `true` means they told us ther
e is one, `false`
   * means they told us there is not, and `undefined` means we never asked —
   * which is what happens whenever the POI sweep already found one within
   * 5 km, because asking a camper to confirm something we can already see is
   * a question that wastes their time.
   */
  hasShower?: boolean;
  hasRestroom?: boolean;
  hasFuel?: boolean;

  /** Somebody knocked. Turns the spot red for everyone. */
  gotKnocked?: boolean;
  /** Free text. Shown to other campers verbatim. */
  comment?: string;
  /** Storage paths of uploaded photos, in the order they were added. */
  photoPaths?: string[];
  /** True when this report came with a four-hour dwell behind it. */
  stayedOvernight?: boolean;
  /** Bars 0-4 at submission time, read from the cell coverage service. */
  cellBars?: number;
  cellCarrier?: string;
}

/* ------------------------------------------------------------------ */
/* Spot context — what the app can work out about a place on its own    */
/* ------------------------------------------------------------------ */

/** One nearby facility found by the POI sweep. */
export interface NearbyPoi {
  kind: 'shower' | 'restroom' | 'fuel';
  name: string;
  metresAway: number;
}

/**
 * Everything the app can establish about a coordinate without asking anybody.
 *
 * This is what removes the two worst parts of the old submission form: typing
 * a name, and answering questions the map could have answered. The name here
 * is BUILT, never invented — it is the nearest named feature plus the land
 * agency, title-cased. No model writes it, so there is nothing to hallucinate.
 */
export interface SpotContext {
  ok: boolean;
  /** The generated name, already title-cased. Empty when nothing was found. */
  name: string;
  /** Where the name came from, in plain English, for the "why this name" line. */
  nameBasis?: string;
  nearestTown?: string;
  stateProvince?: string;
  /** Facilities found within 5 km. An empty array means we looked and found
 none. */
  pois: NearbyPoi[];
  /**
   * True when the POI sweep could not run at all.
   *
   * Load-bearing: with this true, "no shower found" means "we could not look",
   * so the sheet must ASK rather than state. Conflating the two is exactly the
   * kind of overstatement this codebase forbids.
   */
  poiLookupFailed: boolean;
  note?: string;
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

/**
 * The boolean answers that ride along with a vouch.
 *
 * `signs_restricted` is the only one the database acts on, and it is required
 * for that reason. The other two are optional because the report sheet that
 * replaced the old inline form asks about level ground on a three-stop scale
 * and does not ask about noise at all — and sending a hard `false` for a
 * question nobody was asked would store a camper's silence as a denial.
 */
export interface BeaconVerificationAnswers {
  signs_restricted: boolean;
  ground_flat?: boolean;
  quiet_overnight?: boolean;
  note?: string;
}

/** What the ranking model has learned, in a shape worth showing a person. */
export interface BeaconModelSummary {
  region: string;
  stays_recorded: number;
  reports_recorded: number;
  obser
vations_here: number;
  trusts_most: string[];
  trusts_least: string[];
}

/* ------------------------------------------------------------------ *
 * Backroads
 *
 * The unpaved and minor roads drawn as an overlay on the map. Sourced from
 * OpenStreetMap, which means a line here is a road SOMEBODY RECORDED — not a
 * road that is passable, maintained, ungated or legal to drive.
 *
 * `surface` has three states on purpose. OSM leaves the surface tag off far
 * more often than it fills it in, so "nobody wrote it down" is the common
 * case and it must never be rendered as either paved or unpaved.
 * ------------------------------------------------------------------ */

export type BackroadSurface = 'unpaved' | 'paved' | 'unrecorded';

/** What OSM says about driving it. `open` means nothing says otherwise. */
export type BackroadAccess = 'open' | 'permit' | 'private';

/**
 * Four fields, because four fields are what the map draws. What OSM knows
 * and this deliberately does not carry — the name, the gate, `4wd_only`,
 * seasonal access — is listed in `server/backroadRoutes.ts`, along with
 * where to pick it back up.
 */
export interface BackroadWay {
  /** The raw `highway` value — `track`, `service`, `unclassified`… */
  kind: string;
  surface: BackroadSurface;
  access: BackroadAccess;
  /** [lat, lon] pairs, simplified for drawing. */
  line: [number, number][];
}

export interface BackroadScan {
  /** False means we could not check — never "there are no roads here". */
  ok: boolean;
  /** The box asked about was too big to answer. */
  tooWide: boolean;
  /** Roads were dropped to keep the answer drawable. */
  truncated: boolean;
  roads: BackroadWay[];
}
