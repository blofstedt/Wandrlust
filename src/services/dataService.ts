/**
 * The client's single door into Supabase.
 *
 * Design rules:
 *  - Every function degrades gracefully when Supabase is unconfigured or
 *    offline. Nothing here throws into a render path.
 *  - Reads go through RPCs where the server does the geometry work, rather
 *    than pulling rows and filtering in the browser.
 *  - Writes that touch the economy (tokens, unlocks) go through SECURITY
 *    DEFINER functions, never direct table writes.
 */
import { supabase } from '../lib/supabase';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type PresenceStatus = 'in_transit' | 'scouting' | 'parked' | 'offline';
export type VisibilityMode = 'ghost' | 'friends' | 'public';
export type RigType =
  | 'tent' | 'car' | 'suv' | 'van' | 'truck_camper' | 'travel_trailer'
  | 'fifth_wheel' | 'class_a' | 'class_b' | 'class_c' | 'skoolie' | 'overland_rig';

export interface NearbyCamper {
  user_id: string;
  handle: string;
  status: PresenceStatus;
  rig_type: RigType | null;
  note: string | null;
  approx_lat: number;
  approx_lon: number;
  updated_at: string;
}

export interface Rig {
  id: string;
  owner_id: string;
  nickname: string;
  rig_type: RigType;
  height_cm: number | null;
  length_cm: number | null;
  width_cm: number | null;
  gross_weight_kg: number | null;
  ground_clearance_cm: number | null;
  is_4wd: boolean;
  has_trailer: boolean;
  is_primary: boolean;
}

export interface HostListing {
  id: string;
  host_id: string;
  title: string;
  description: string | null;
  latitude?: number;
  longitude?: number;
  approx_only: boolean;
  token_price: number;
  max_nights: number;
  max_rig_length_cm: number | null;
  max_rigs: number;
  has_water: boolean;
  has_toilet: boolean;
  has_shower: boolean;
  has_power: boolean;
  has_dump_station: boolean;
  has_wifi: boolean;
  allows_fires: boolean;
  allows_pets: boolean;
  allows_generators: boolean;
  is_pull_through: boolean;
  surface_type: string | null;
  quiet_hours: string | null;
  arrival_notes: string | null;
  photos: string[];
  is_active: boolean;
}

export interface Booking {
  id: string;
  listing_id: string;
  guest_id: string;
  host_id: string;
  starts_on: string;
  ends_on: string;
  token_cost: number;
  status: 'requested' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  guest_reviewed: boolean;
  host_reviewed: boolean;
}

export interface BookingReview {
  id: string;
  booking_id: string;
  author_id: string;
  subject_id: string;
  direction: 'guest_to_host' | 'host_to_guest';
  rating: number;
  comment: string;
  accuracy_rating: number | null;
  cleanliness_rating: number | null;
  access_rating: number | null;
  is_visible: boolean;
  created_at: string;
}

export interface PoiRecord {
  id: string;
  kind: string;
  name: string;
  detail: string | null;
  latitude: number;
  longitude: number;
  is_free: boolean | null;
  price_cents: number | null;
  status: 'pending' | 'promoted' | 'pruned';
  upvotes: number;
  downvotes: number;
}

export interface HazardRecord {
  id: string;
  kind: string;
  latitude: number;
  longitude: number;
  detail: string | null;
  confirms: number;
  disputes: number;
  created_at: string;
  expires_at: string;
}

export interface ZoneAlert {
  id: string;
  reason: string;
  radius_km: number;
  severity: number;
  report_count: number;
  notes: string | null;
  active_until: string;
}

export interface PointHazard {
  kind: string;
  family: string;
  title: string;
  detail: string | null;
  severity: string;
  stage: string | null;
  authority: string | null;
  source_url: string | null;
  expires: string | null;
}

export interface PointRules {
  land_name: string;
  designation: string;
  confidence: string;
  attribution: string;
  stay_limit_days: number | null;
  permit_required: boolean;
  permit_name: string | null;
  permit_url: string | null;
  fire_ban_active: boolean;
  campfire_policy: string | null;
  waste_policy: string | null;
  setback_water_m: number | null;
  leave_no_trace: string | null;
}

export interface UserSettings {
  user_id: string;
  notify_fire_alerts: boolean;
  notify_flood_alerts: boolean;
  notify_storm_alerts: boolean;
  notify_zone_heat: boolean;
  notify_hazards_nearby: boolean;
  notify_booking_updates: boolean;
  alert_radius_km: number;
  share_presence: boolean;
  share_telemetry: boolean;
  use_metric: boolean;
  map_style: string;
  show_support_link: boolean;
  push_enabled?: boolean;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const ok = <T>(data: T | null, fallback: T): T => data ?? fallback;

/** Uniform result so callers never have to catch. */
export interface Result<T> {
  ok: boolean;
  data: T | null;
  message: string;
}

const success = <T>(data: T, message = ''): Result<T> => ({ ok: true, data, message });
const failure = <T>(message: string): Result<T> => ({ ok: false, data: null, message });

const currentUserId = async (): Promise<string | null> => {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ?? null;
};

/* ------------------------------------------------------------------ */
/* Campsites                                                           */
/* ------------------------------------------------------------------ */

/**
 * Tier-aware campsite read. Stealth pins are hidden or fuzzed server-side
 * according to the caller's trust tier — the client never receives exact
 * coordinates it isn't entitled to.
 */
export const fetchVisibleCampsites = async (
  lat: number,
  lon: number,
  radiusMiles = 100
) => {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('campsites_visible', {
    in_lat: lat,
    in_lon: lon,
    in_radius_miles: radiusMiles
  });
  if (error) return [];
  return ok(data, []);
};

export const unlockStealthSite = async (campsiteId: string): Promise<Result<any>> => {
  if (!supabase) return failure('Not connected');
  const { data, error } = await supabase.rpc('unlock_stealth_site', {
    in_campsite: campsiteId
  });
  if (error) return failure(error.message);
  return success(data?.[0] ?? data, 'Location unlocked');
};

export const saveCampsiteRemote = async (campsiteId: string, notes?: string) => {
  if (!supabase) return failure('Not connected');
  const { error } = await supabase
    .from('saved_campsites')
    .upsert({ campsite_id: campsiteId, notes: notes ?? null });
  return error ? failure(error.message) : success(true, 'Saved');
};

export const unsaveCampsiteRemote = async (campsiteId: string) => {
  if (!supabase) return failure('Not connected');
  const { error } = await supabase
    .from('saved_campsites')
    .delete()
    .eq('campsite_id', campsiteId);
  return error ? failure(error.message) : success(true, 'Removed');
};

/* ------------------------------------------------------------------ */
/* Presence                                                            */
/* ------------------------------------------------------------------ */

/**
 * Publish your position.
 *
 * Ghost is the default everywhere. The server stores precise geometry but RLS
 * makes it owner-readable only; other users receive a ~1 km grid-snapped
 * position through nearby_campers().
 */
export const publishPresence = async (
  lat: number,
  lon: number,
  status: PresenceStatus,
  visibility: VisibilityMode,
  rigType?: RigType | null,
  note?: string | null
): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to share your position');

  const { error } = await supabase.from('presence').upsert({
    user_id: uid,
    geom: `SRID=4326;POINT(${lon} ${lat})`,
    status,
    visibility,
    rig_type: rigType ?? null,
    note: note ?? null,
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
  });
  return error ? failure(error.message) : success(true, 'Position shared');
};

export const goGhost = async (): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Not signed in');
  const { error } = await supabase.from('presence').delete().eq('user_id', uid);
  return error ? failure(error.message) : success(true, 'You are now hidden');
};

export const fetchNearbyCampers = async (
  lat: number,
  lon: number,
  radiusKm = 50
): Promise<NearbyCamper[]> => {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('nearby_campers', {
    in_lat: lat,
    in_lon: lon,
    in_radius_km: radiusKm
  });
  if (error) return [];
  return ok(data, []);
};

/* ------------------------------------------------------------------ */
/* Rigs                                                                */
/* ------------------------------------------------------------------ */

export const fetchMyRigs = async (): Promise<Rig[]> => {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('rigs')
    .select('*')
    .order('is_primary', { ascending: false });
  if (error) return [];
  return ok(data, []);
};

export const saveRig = async (rig: Partial<Rig>): Promise<Result<Rig>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to save a rig');

  const payload = { ...rig, owner_id: uid };
  const { data, error } = rig.id
    ? await supabase.from('rigs').update(payload).eq('id', rig.id).select().single()
    : await supabase.from('rigs').insert(payload).select().single();

  return error ? failure(error.message) : success(data as Rig, 'Rig saved');
};

/* ------------------------------------------------------------------ */
/* Check-ins & tokens                                                  */
/* ------------------------------------------------------------------ */

export const checkIn = async (
  campsiteId: string,
  capacity: 'empty' | 'light' | 'busy' | 'full' | 'unknown',
  rigType?: RigType | null,
  notes?: string
): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to check in');

  const { error } = await supabase.from('check_ins').insert({
    user_id: uid,
    campsite_id: campsiteId,
    capacity,
    rig_type: rigType ?? null,
    notes: notes ?? null
  });
  if (error) return failure(error.message);

  // Keep the campsite's live capacity fresh for everyone else.
  await supabase
    .from('campsites')
    .update({ capacity_status: capacity, capacity_updated_at: new Date().toISOString() })
    .eq('id', campsiteId);

  return success(true, 'Checked in');
};

export const checkOut = async (
  checkInId: string,
  capacity?: 'empty' | 'light' | 'busy' | 'full'
): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const patch: Record<string, unknown> = { departed_at: new Date().toISOString() };
  if (capacity) patch.capacity = capacity;
  const { error } = await supabase.from('check_ins').update(patch).eq('id', checkInId);
  return error ? failure(error.message) : success(true, 'Checked out');
};

export const fetchTokenLedger = async (limit = 50) => {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('token_ledger')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return ok(data, []);
};

export const fetchTokenRules = async () => {
  if (!supabase) return [];
  const { data, error } = await supabase.from('token_rules').select('*');
  if (error) return [];
  return ok(data, []);
};

/* ------------------------------------------------------------------ */
/* Hosting                                                             */
/* ------------------------------------------------------------------ */

export const fetchHostListings = async (): Promise<HostListing[]> => {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('host_listings')
    .select('*')
    .eq('is_active', true)
    .limit(200);
  if (error) return [];
  return ok(data, []);
};

export const fetchMyListings = async (): Promise<HostListing[]> => {
  if (!supabase) return [];
  const { data, error } = await supabase.from('host_listings').select('*');
  if (error) return [];
  return ok(data, []);
};

export const saveListing = async (
  listing: Partial<HostListing> & { latitude: number; longitude: number }
): Promise<Result<HostListing>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to list your property');

  const { latitude, longitude, ...rest } = listing;
  const payload = {
    ...rest,
    host_id: uid,
    geom: `SRID=4326;POINT(${longitude} ${latitude})`
  };

  const { data, error } = listing.id
    ? await supabase.from('host_listings').update(payload).eq('id', listing.id).select().single()
    : await supabase.from('host_listings').insert(payload).select().single();

  if (error) return failure(error.message);

  // Mark the profile as a host so the UI can surface host tools.
  await supabase.from('profiles').update({ is_host: true }).eq('id', uid);
  return success(data as HostListing, 'Listing saved');
};

export const requestBooking = async (
  listingId: string,
  hostId: string,
  startsOn: string,
  endsOn: string,
  tokenCost: number
): Promise<Result<Booking>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to book');

  const { data, error } = await supabase
    .from('bookings')
    .insert({
      listing_id: listingId,
      guest_id: uid,
      host_id: hostId,
      starts_on: startsOn,
      ends_on: endsOn,
      token_cost: tokenCost
    })
    .select()
    .single();

  return error ? failure(error.message) : success(data as Booking, 'Booking requested');
};

export const fetchMyBookings = async (): Promise<Booking[]> => {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return [];
  return ok(data, []);
};

export const updateBookingStatus = async (
  bookingId: string,
  status: Booking['status']
): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const { error } = await supabase.from('bookings').update({ status }).eq('id', bookingId);
  return error ? failure(error.message) : success(true, `Booking ${status}`);
};

/**
 * Submit a review. Double-blind: it stays hidden until the other party files
 * theirs, so nobody can retaliate against a review they've read.
 */
export const submitBookingReview = async (review: {
  bookingId: string;
  subjectId: string;
  direction: 'guest_to_host' | 'host_to_guest';
  rating: number;
  comment: string;
  accuracy?: number;
  cleanliness?: number;
  access?: number;
}): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to leave a review');

  const { error } = await supabase.from('booking_reviews').insert({
    booking_id: review.bookingId,
    author_id: uid,
    subject_id: review.subjectId,
    direction: review.direction,
    rating: review.rating,
    comment: review.comment,
    accuracy_rating: review.accuracy ?? null,
    cleanliness_rating: review.cleanliness ?? null,
    access_rating: review.access ?? null
  });

  if (error) return failure(error.message);
  return success(true, 'Review submitted. It stays hidden until the other party reviews too.');
};

export const fetchReviewsFor = async (userId: string): Promise<BookingReview[]> => {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('booking_reviews')
    .select('*')
    .eq('subject_id', userId)
    .eq('is_visible', true)
    .order('created_at', { ascending: false });
  if (error) return [];
  return ok(data, []);
};

/* ------------------------------------------------------------------ */
/* Hazards, POIs, zone alerts                                          */
/* ------------------------------------------------------------------ */

export const reportHazard = async (
  kind: string,
  lat: number,
  lon: number,
  detail?: string
): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to report');

  const { error } = await supabase.from('hazard_reports').insert({
    user_id: uid,
    kind,
    geom: `SRID=4326;POINT(${lon} ${lat})`,
    detail: detail ?? null
  });
  return error ? failure(error.message) : success(true, 'Hazard reported');
};

export const confirmHazard = async (
  hazardId: string,
  agrees: boolean
): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to confirm');

  const { error } = await supabase
    .from('hazard_confirmations')
    .insert({ hazard_id: hazardId, user_id: uid, agrees });
  return error ? failure(error.message) : success(true, agrees ? 'Confirmed' : 'Disputed');
};

export const fetchActiveHazards = async (): Promise<HazardRecord[]> => {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('hazard_reports')
    .select('*')
    .eq('is_active', true)
    .limit(300);
  if (error) return [];
  return ok(data, []);
};

export const fetchZoneAlerts = async (
  lat: number,
  lon: number,
  radiusKm = 100
): Promise<ZoneAlert[]> => {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('zone_alerts_near', {
    in_lat: lat,
    in_lon: lon,
    in_radius_km: radiusKm
  });
  if (error) return [];
  return ok(data, []);
};

export const reportBurnedSite = async (
  campsiteId: string,
  reason: string,
  detail?: string
): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to report');

  const { error } = await supabase.from('site_reports').insert({
    campsite_id: campsiteId,
    user_id: uid,
    reason,
    detail: detail ?? null
  });
  return error ? failure(error.message) : success(true, 'Report filed');
};

export const submitPoi = async (poi: {
  kind: string;
  name: string;
  lat: number;
  lon: number;
  detail?: string;
  isFree?: boolean;
  priceCents?: number;
}): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to submit');

  const { error } = await supabase.from('pois').insert({
    kind: poi.kind,
    name: poi.name,
    geom: `SRID=4326;POINT(${poi.lon} ${poi.lat})`,
    detail: poi.detail ?? null,
    is_free: poi.isFree ?? null,
    price_cents: poi.priceCents ?? null,
    submitted_by: uid,
    status: 'pending'
  });
  return error ? failure(error.message) : success(true, 'POI submitted for review');
};

export const votePoi = async (poiId: string, isUpvote: boolean): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to vote');

  const { error } = await supabase
    .from('poi_votes')
    .insert({ poi_id: poiId, user_id: uid, is_upvote: isUpvote });
  return error ? failure(error.message) : success(true, 'Vote recorded');
};

export const fetchPois = async (): Promise<PoiRecord[]> => {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('pois')
    .select('*')
    .neq('status', 'pruned')
    .limit(300);
  if (error) return [];
  return ok(data, []);
};

/* ------------------------------------------------------------------ */
/* Rules & hazards at a point                                          */
/* ------------------------------------------------------------------ */

export const fetchRulesAtPoint = async (
  lat: number,
  lon: number
): Promise<PointRules[]> => {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('rules_at_point', { in_lat: lat, in_lon: lon });
  if (error) return [];
  return ok(data, []);
};

export const fetchHazardsAtPoint = async (
  lat: number,
  lon: number
): Promise<PointHazard[]> => {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('hazards_at_point', { in_lat: lat, in_lon: lon });
  if (error) return [];
  return ok(data, []);
};

/* ------------------------------------------------------------------ */
/* Telemetry                                                           */
/* ------------------------------------------------------------------ */

export const uploadTelemetryBatch = async (batch: {
  recordedAt: string;
  path: [number, number][];
  sampleHz: number;
  meanSpeedKph: number;
  verticalVariance: number;
  dashMounted: boolean;
  rigId?: string | null;
}): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to contribute road data');
  if (batch.path.length < 2) return failure('Path too short');

  const wkt = `SRID=4326;LINESTRING(${batch.path
    .map(([lon, lat]) => `${lon} ${lat}`)
    .join(',')})`;

  const { error } = await supabase.from('telemetry_batches').insert({
    user_id: uid,
    rig_id: batch.rigId ?? null,
    recorded_at: batch.recordedAt,
    path: wkt,
    sample_hz: batch.sampleHz,
    mean_speed_kph: batch.meanSpeedKph,
    vertical_variance: batch.verticalVariance,
    dash_mounted: batch.dashMounted
  });

  // The DB trigger decides acceptance and pays tokens; a rejected batch is
  // still stored so the filter can be retuned later without losing data.
  return error ? failure(error.message) : success(true, 'Road data uploaded');
};

export const fetchRoadSegments = async () => {
  if (!supabase) return [];
  const { data, error } = await supabase.from('road_segments').select('*').limit(500);
  if (error) return [];
  return ok(data, []);
};

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const fetchSettings = async (): Promise<UserSettings | null> => {
  if (!supabase) return null;
  const uid = await currentUserId();
  if (!uid) return null;

  const { data } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', uid)
    .maybeSingle();

  if (data) return data as UserSettings;

  // First run: create defaults.
  const { data: created } = await supabase
    .from('user_settings')
    .insert({ user_id: uid })
    .select()
    .single();
  return (created as UserSettings) ?? null;
};

export const saveSettings = async (
  patch: Partial<UserSettings>
): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Not signed in');

  const { error } = await supabase.from('user_settings').upsert({ ...patch, user_id: uid });
  return error ? failure(error.message) : success(true, 'Settings saved');
};
