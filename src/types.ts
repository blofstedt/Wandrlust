export type LandType = 'blm' | 'usfs' | 'state_forest' | 'dispersed' | 'crown_land';

export type RoadAccess = 'paved' | 'gravel' | 'high_clearance' | '4x4_only';

export type ToiletType = 'none' | 'vault' | 'flush' | 'pack_out';

export type WaterType = 'none' | 'potable' | 'natural_stream' | 'seasonal_creek';

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
  shade: 'full' | 'partial' | 'none';
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
  /** Optional: verified against an authoritative boundary dataset. */
  isCrownLand?: boolean;
  landType: LandType;
  landManager: string; // e.g., "Bureau of Land Management", "US Forest Service", "Bridger-Teton NF"
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
  rating: number; // average rating
  reviewCount: number;
  source: 'verified' | 'overpass' | 'user_submitted' | 'gemini_discovered';
  savedOffline?: boolean;
}

export interface GeocodedLocation {
  displayName: string;
  city: string;
  stateProvince: string;
  country: string;
  lat: number;
  lon: number;
  boundingBox?: [number, number, number, number]; // [south, north, west, east]
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

export type MapTileLayer = 'topo' | 'satellite' | 'street' | 'public_lands';


