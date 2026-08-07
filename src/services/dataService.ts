/**
 * The client's single door into Supabase.
 *
 * Design rules:
 *  - Every function degrades gracefully when Supabase is unconfigured or
 *    offline. Nothing here throws into a render path.
 *  - Reads go through RPCs where the server does the geometry work, rather
 *    than pulling rows and filtering in the browser.
 *  - Writes that touch the economy (points, unlocks) go through SECURITY
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

/**
 * Who you have an accepted friendship with, as a set of user ids.
 *
 * Used by navigation mode to decide whose name is safe to draw on the map.
 * Everyone else on screen stays unnamed.
 *
 * The friendship is symmetric but the row is not — either party may have sent
 * the request — so both directions are read and merged. RLS already limits
 * this table to rows you are part of, so there is no filter for that here.
 */
export const fetchFriendIds = async (): Promise<Set<string>> => {
  if (!supabase) return new Set();
  const uid = await currentUserId();
  if (!uid) return new Set();

  const { data, error } = await supabase
    .from('friendships')
    .select('requester_id, addressee_id')
    .eq('status', 'accepted');

  if (error || !data) return new Set();

  return new Set(
    data.map((row: { requester_id: string; addressee_id: string }) =>
      row.requester_id === uid ? row.addressee_id : row.requester_id
    )
  );
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
/* Check-ins & points                                                  */
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

export const fetchPointsLedger = async (limit = 50) => {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('points_ledger')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return ok(data, []);
};

export const fetchPointsRules = async () => {
  if (!supabase) return [];
  const { data, error } = await supabase.from('points_rules').select('*');
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

/**
 * Active camper hazard reports around a point.
 *
 * Goes through the `hazards_near` RPC (migration 09) rather than reading the
 * table, because `hazard_reports.geom` is a PostGIS point and PostgREST hands
 * that back as EWKB hex — the previous direct read produced records whose
 * latitude and longitude were `undefined`, which no caller had noticed because
 * nothing drew them. The RPC projects to lat/lon and filters by distance in
 * the database.
 *
 * Positions are exact, deliberately: a washout is a place on a road, and a
 * hazard rounded to the nearest kilometre is a hazard you drive into.
 */
export const fetchHazardsNear = async (
  lat: number,
  lon: number,
  radiusKm = 150
): Promise<HazardRecord[]> => {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('hazards_near', {
    in_lat: lat,
    in_lon: lon,
    in_radius_km: radiusKm
  });
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

  // The DB trigger decides acceptance and pays points; a rejected batch is
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
