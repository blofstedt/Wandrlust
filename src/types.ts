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

export interface CampsiteAmenities {
  water: WaterType;
  toilet: ToiletType;
  roadAccess: RoadAccess;
  cellSignal: CellSignal;
  maxRvLengthFeet?: number; // 0 if tent only
  fireRing: boolean;
  petFriendly: boolean;
  trashService: boolean;
  shade: ShadeType;
  stayLimitDays: number;
  isFree: boolean;
  permitRequired: boolean;
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
}

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

export type LegalDocKind = 'privacy_policy' | 'terms_of_service' | 'safety_disclaimer';
