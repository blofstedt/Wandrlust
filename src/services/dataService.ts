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
import { campsiteIdKind } from '../utils/campsiteId';
import type { Campsite, CamperReview } from '../types';

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

/**
 * Make sure this campsite exists in the database before pointing at it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Six tables carry `campsite_id text not null references campsites(id)`. The
 * app shows campsites from four places, and only two of them are in that
 * table: the curated bundle and other campers' contributions. Tap check-in on
 * a site that came from OpenStreetMap and the insert violated a foreign key,
 * and `CampsiteBottomSheet` printed the raw Postgres error at the camper.
 *
 * So an OSM site is materialised on first interaction — it becomes a real
 * shared record, which is what lets it accumulate check-ins, a capacity and a
 * rating like anything else.
 *
 * A site that exists ONLY on this device cannot be materialised: it has never
 * been submitted, so there is nothing for anyone else to reference. That is
 * reported as a plain sentence, and the UI is expected not to offer the
 * action in the first place.
 */
export const ensureCampsiteExists = async (site: Campsite): Promise<Result<string>> => {
  if (!supabase) return failure('Not connected');

  // Curated and Supabase-native ids are already rows. Anything device-local
  // never will be until it is submitted.
  if (site.id.startsWith('user-') || site.id.startsWith('custom-')) {
    return failure('Share this spot first so other campers can see it.');
  }
  if (!/^osm-(node|way|relation)-\d+$/.test(site.id)) return success(site.id);

  const { data, error } = await supabase.rpc('ensure_campsite', {
    in_id: site.id,
    in_name: site.name,
    in_land_type: site.landType,
    in_lat: site.latitude,
    in_lon: site.longitude,
    in_land_manager: site.landManager ?? '',
    in_description: site.description ?? ''
  });

  if (error) return failure(error.message);
  return success(String(data ?? site.id));
};

/** True when this site can carry a check-in, review or report at all. */
export const canReferenceCampsite = (site: Campsite): boolean =>
  !site.id.startsWith('user-') && !site.id.startsWith('custom-');

/**
 * Campsites other people can see, in the app's own shape.
 *
 * ---------------------------------------------------------------------------
 * WHY `amenities` COMES BACK EMPTY, DELIBERATELY
 * ---------------------------------------------------------------------------
 *
 * `public.campsites` declares water, toilet, road_access, cell_* and
 * stay_limit_days as NOT NULL with defaults — 'none', 'gravel', 0, 14. So a
 * site nobody has ever surveyed is stored as "no water, gravel road, no
 * signal, 14-day limit", and nothing in the row distinguishes that from a
 * ranger having checked. Reading those columns back would put fabricated
 * facts in front of a camper deciding where to sleep, which is the single
 * thing this app has decided it will never do.
 *
 * Verified against the real data: of the 21 curated sites, exactly five
 * record `is_free` and one records `permit_required`. Every other amenity
 * column in the database is a default nobody chose.
 *
 * So this mapper carries identity, position and provenance, and leaves
 * `amenities` empty — which the UI already renders as "not recorded" rather
 * than as "no". Making those columns nullable is the real fix and is a
 * migration of its own.
 *
 * Never throws. Returns [] with no Supabase configured, which is what keeps
 * the app working with no keys at all.
 */
/**
 * One database row in the app's shape.
 *
 * Shared by `campsites_visible` and `campsites_saved`, which return the same
 * columns under the same stealth rules — so the two reads have to agree about
 * what a row means. Returns [] for a row with no usable position, so callers
 * can flatMap it away.
 */
const mapCampsiteRow = (row: any, uid: string | null): Campsite[] => {
  if (typeof row?.latitude !== 'number' || typeof row?.longitude !== 'number') return [];

  return [{
    id: String(row.id),
    name: row.name ?? 'Unnamed site',
    landType: row.land_type,
    landManager: row.land_manager ?? '',
    latitude: row.latitude,
    longitude: row.longitude,
    address: {
      nearestCity: row.nearest_city ?? '',
      stateProvince: row.state_province ?? '',
      country: row.country ?? ''
    },
    description: row.description ?? '',
    amenities: {},
    images: Array.isArray(row.images) ? row.images : [],
    reviews: [],
    rating: Number(row.rating ?? 0),
    reviewCount: Number(row.review_count ?? 0),
    source: row.source ?? 'user_submitted',
    capacityStatus: row.capacity_status ?? undefined,
    isStealth: Boolean(row.is_stealth),
    // The server fuzzed this position to ~2 km because the caller has not
    // earned the exact one. The sheet says so rather than drawing it as
    // though it were surveyed.
    isApproximate: Boolean(row.is_approximate),
    submissionState: row.is_published ? 'published' : 'pending_review',
    submittedByMe: Boolean(uid) && row.submitted_by === uid
  }];
};

export const fetchCampsitesNear = async (
  lat: number,
  lon: number,
  radiusMiles = 100
): Promise<Campsite[]> => {
  const rows = await fetchVisibleCampsites(lat, lon, radiusMiles);
  if (!Array.isArray(rows)) return [];

  // Resolved once for the whole batch rather than per row.
  const uid = await currentUserId();

  return rows.flatMap((row: any) => mapCampsiteRow(row, uid));
};

/**
 * Share a spot the user just added, so other campers can eventually see it.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FIXES
 * ---------------------------------------------------------------------------
 *
 * "Submit a new free spot" wrote to browser storage and stopped there. The
 * table, the row-level security policy and the moderation gate all existed and
 * had existed for months; nothing was wired to them. So the app's headline
 * contribution — the thing the points system pays for and the trust ladder is
 * built around — was a private bookmark that died with the browser profile.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT SENT
 * ---------------------------------------------------------------------------
 *
 * Only the columns the form actually asked a human about. The amenity columns
 * are NOT NULL with defaults ('none', 'gravel', 14 days, 0 bars), so writing
 * `undefined` into them would silently record "no water, gravel road, no
 * signal" as though somebody had checked. Omitting them lets the defaults
 * apply and — crucially — is why `fetchCampsitesNear` refuses to read them
 * back. The two halves of that decision have to stay in step.
 *
 * The row lands with `is_published = false`, so it is visible to its author
 * and to nobody else until it is reviewed.
 */
export const submitCampsite = async (
  site: Campsite
): Promise<Result<{ pending: boolean }>> => {
  if (!supabase) return failure('Saved on this device only — no server configured.');

  const uid = await currentUserId();
  if (!uid) return failure('Saved on this device. Sign in to share it with other campers.');

  const { error } = await supabase.from('campsites').insert({
    id: site.id,
    name: site.name,
    land_type: site.landType,
    land_manager: site.landManager || null,
    latitude: site.latitude,
    longitude: site.longitude,
    nearest_city: site.address?.nearestCity || null,
    state_province: site.address?.stateProvince || null,
    country: site.address?.country || null,
    description: site.description || null,
    images: Array.isArray(site.images) ? site.images : [],
    source: 'user_submitted',
    is_published: false,
    land_verification: 'unverified',
    submitted_by: uid
  });

  // A duplicate id means this device already sent it — a re-submit after a
  // dropped connection, or the same uuid from a restored backup. Not a
  // failure worth showing anyone.
  if (error && error.code === '23505') return success({ pending: true });
  if (error) return failure(error.message);

  return success({ pending: true });
};

/**
 * Which of this user's own submissions have since been published.
 *
 * One query on load rather than a per-site check. Relies on the author-read
 * policy added in migration 10 — before it, a submitter could not see their
 * own pending row at all, which made the chip below impossible to keep honest.
 */
export const fetchMySubmissionStates = async (): Promise<Map<string, boolean>> => {
  const out = new Map<string, boolean>();
  if (!supabase) return out;

  const uid = await currentUserId();
  if (!uid) return out;

  const { data, error } = await supabase
    .from('campsites')
    .select('id, is_published')
    .eq('submitted_by', uid);

  if (error || !Array.isArray(data)) return out;
  for (const row of data) out.set(String(row.id), Boolean(row.is_published));
  return out;
};

/* ------------------------------------------------------------------ */
/* Reviews                                                             */
/* ------------------------------------------------------------------ */

/**
 * Reviews for one site.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FIXES
 * ---------------------------------------------------------------------------
 *
 * Leaving a review recomputed the site's average in React state and stopped.
 * Not localforage, not the server — a page reload erased it. `campsite_reviews`
 * and its `refresh_campsite_rating` trigger have both existed since the first
 * schema and no client code had ever referenced them.
 *
 * Hidden reviews are filtered by the row-level security policy, not here, so a
 * review hidden after being reported disappears for everyone except its
 * author — who keeps seeing their own, because a review that silently vanishes
 * for the person who wrote it just looks like the app ate it.
 */
export const fetchCampsiteReviews = async (campsiteId: string): Promise<CamperReview[]> => {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('campsite_reviews')
    .select('id, author, rating, comment, vehicle_type, created_at')
    .eq('campsite_id', campsiteId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error || !Array.isArray(data)) return [];

  return data.map((row: any) => ({
    id: String(row.id),
    author: row.author ?? 'A camper',
    date: row.created_at ?? new Date().toISOString(),
    rating: Number(row.rating ?? 0),
    comment: row.comment ?? '',
    vehicleType: row.vehicle_type ?? undefined
  }));
};

/**
 * Leave or update a review.
 *
 * `author` is a SNAPSHOT of the handle at the time of writing, not a join. It
 * is stored alongside `user_id` so a review still reads sensibly after the
 * profile behind it is deleted — `user_id` is `on delete set null`, and a
 * review suddenly attributed to nobody is worse than one attributed to a name
 * that no longer has an account.
 *
 * Upserted on the (campsite_id, user_id) index, so editing yours updates the
 * row rather than adding a second one. The rating trigger recomputes the
 * site's average either way.
 */
export const submitCampsiteReview = async (
  site: Campsite,
  review: { rating: number; comment: string; vehicleType?: string }
): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');

  const uid = await currentUserId();
  if (!uid) return failure('Sign in to leave a review.');

  if (!Number.isFinite(review.rating) || review.rating < 1 || review.rating > 5) {
    return failure('Pick a rating between 1 and 5.');
  }
  if (review.comment.trim().length === 0) return failure('Add a few words about the spot.');

  // An OSM site has no row until somebody interacts with it. This is that
  // moment, and without it the insert fails the foreign key.
  const ready = await ensureCampsiteExists(site);
  if (!ready.ok) return failure(ready.message);

  const { data: profile } = await supabase
    .from('profiles')
    .select('handle, display_name')
    .eq('id', uid)
    .maybeSingle();

  const author = (profile?.display_name || profile?.handle || 'A camper').slice(0, 60);

  const { error } = await supabase
    .from('campsite_reviews')
    .upsert(
      {
        campsite_id: ready.data,
        user_id: uid,
        author,
        rating: Math.round(review.rating),
        comment: review.comment.trim().slice(0, 2000),
        vehicle_type: review.vehicleType?.trim() || null
      },
      { onConflict: 'campsite_id,user_id' }
    );

  if (error) return failure(error.message);
  return success(true);
};

/** Remove your own review. The policy allows no other. */
export const deleteMyReview = async (reviewId: string): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const { error } = await supabase.from('campsite_reviews').delete().eq('id', reviewId);
  if (error) return failure(error.message);
  return success(true);
};

/** The site's rating and count after the trigger has recomputed them. */
export const fetchCampsiteRating = async (
  campsiteId: string
): Promise<{ rating: number; reviewCount: number } | null> => {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('campsites')
    .select('rating, review_count')
    .eq('id', campsiteId)
    .maybeSingle();

  if (error || !data) return null;
  return {
    rating: Number(data.rating ?? 0),
    reviewCount: Number(data.review_count ?? 0)
  };
};

/* ------------------------------------------------------------------ */
/* Reporting bad content                                               */
/* ------------------------------------------------------------------ */

export type ReportTargetKind = 'campsite' | 'campsite_review' | 'campsite_photo' | 'poi';

export type ContentReportReason =
  | 'spam' | 'wrong_location' | 'private_property' | 'unsafe'
  | 'abusive' | 'not_camping' | 'other';

/**
 * Flag a record as bad.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * NOT `reportBurnedSite`. That one is about the PLACE — gated, closed, washed
 * out, someone moved you on — and it feeds the zone-alert clustering. This is
 * about the RECORD: a listing on private land, a fake spot, an abusive review.
 * Conflating the two is how a moderation queue fills up with "road impassable"
 * and nobody finds the actual spam.
 *
 * Until this existed there was no flag, edit, or remove path for user content
 * anywhere in the app. A community app that cannot take bad data down is a
 * liability, and especially so for one whose stated rule is never to claim
 * more than it knows.
 *
 * Three distinct reporters auto-hide the target — deliberately low, because
 * pre-launch there is no moderator on duty. `is_hidden` is a curtain, not an
 * eraser: nothing is deleted, and a wrong call costs nothing but a service-role
 * update to undo.
 */
export const reportContent = async (
  targetKind: ReportTargetKind,
  targetId: string,
  reason: ContentReportReason,
  detail?: string
): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');

  const uid = await currentUserId();
  if (!uid) return failure('Sign in to report something.');

  const { error } = await supabase.from('content_reports').insert({
    target_kind: targetKind,
    target_id: targetId,
    reporter_id: uid,
    reason,
    detail: detail?.trim().slice(0, 1000) || null
  });

  // Already reported by this person. The unique index makes a second one a
  // no-op, and telling them off for tapping twice serves nobody.
  if (error && error.code === '23505') return success(true);
  if (error) return failure(error.message);

  return success(true);
};


export const unlockStealthSite = async (campsiteId: string): Promise<Result<any>> => {
  if (!supabase) return failure('Not connected');
  const { data, error } = await supabase.rpc('unlock_stealth_site', {
    in_campsite: campsiteId
  });
  if (error) return failure(error.message);
  return success(data?.[0] ?? data, 'Location unlocked');
};

/* ------------------------------------------------------------------ */
/* Saved campsites                                                     */
/* ------------------------------------------------------------------ */

/**
 * Put a bookmark on the account instead of only in this browser.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FIXES
 * ---------------------------------------------------------------------------
 *
 * These two functions existed and nothing called them, so the bookmark button
 * wrote to localforage and stopped. A camper's saved list died with the
 * browser profile — reinstall, clear site data, or pick up a second device and
 * every spot they had kept was gone. The table and its owner-only policy had
 * been sitting there since migration 04.
 *
 * They were also both wrong, which is presumably why they were never wired up:
 * `user_id` is `not null` with no default and the upsert never sent one, so the
 * insert could only ever have failed. Migration 12 defaults the column to
 * `auth.uid()` — the same expression the RLS policy checks it against — so the
 * client no longer names it at all.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ALLOWED TO FAIL
 * ---------------------------------------------------------------------------
 *
 * `saved_campsites.campsite_id` is a foreign key into `campsites`, so a site
 * that has never reached the server cannot be bookmarked on the server. Two
 * kinds of site are like that: one somebody added on this device and never
 * shared, and an OSM result nobody has interacted with yet. The second is
 * fixable — `ensureCampsiteExists` materialises it — and the first is not.
 *
 * So the foreign-key violation is caught and reported as a plain sentence
 * rather than a Postgres error. The local bookmark has already been written by
 * the caller and is never rolled back on this result: on a phone at a trailhead
 * the device copy is the one that matters.
 */
export const saveCampsiteRemote = async (
  site: Campsite,
  notes?: string
): Promise<Result<boolean>> => {
  if (!supabase) return failure('Saved on this device only — no server configured.');

  const uid = await currentUserId();
  if (!uid) return failure('Saved on this device. Sign in to keep it on your account.');

  // An OSM site has to become a real row before anything can point at it.
  if (campsiteIdKind(site.id) === 'osm') {
    const materialised = await ensureCampsiteExists(site);
    if (!materialised.ok) return failure(materialised.message);
  }

  const { error } = await supabase
    .from('saved_campsites')
    .upsert(
      { user_id: uid, campsite_id: site.id, notes: notes ?? null },
      { onConflict: 'user_id,campsite_id' }
    );

  // 23503 = foreign key violation: this spot only exists on this device.
  if (error?.code === '23503') {
    return failure('Saved on this device. Share this spot to keep it on your account.');
  }
  if (error) return failure(error.message);

  return success(true, 'Saved');
};

/**
 * Drop the bookmark from the account.
 *
 * Scoped to the caller explicitly as well as by RLS. The policy already
 * confines the delete to your own rows, but a delete whose WHERE clause relies
 * entirely on a policy is one policy edit away from being a very bad day.
 */
export const unsaveCampsiteRemote = async (campsiteId: string): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');

  const uid = await currentUserId();
  if (!uid) return failure('Not signed in');

  const { error } = await supabase
    .from('saved_campsites')
    .delete()
    .eq('user_id', uid)
    .eq('campsite_id', campsiteId);

  return error ? failure(error.message) : success(true, 'Removed');
};

/**
 * The saved list as the account knows it.
 *
 * ---------------------------------------------------------------------------
 * WHY A `null` RETURN AND NOT AN EMPTY ARRAY
 * ---------------------------------------------------------------------------
 *
 * The caller merges this with the device's own saved list, and the difference
 * between "the server says you have saved nothing" and "the server could not
 * be reached" decides whether a bookmark gets pushed up or thrown away. Every
 * other read here returns [] on failure because the worst case is a thin map;
 * here the worst case is deleting somebody's saved spots on a bad connection.
 *
 * So: an array means the server answered, `null` means it did not, and the
 * caller must never treat `null` as empty.
 *
 * Note that even a successful read can be shorter than the row count — a site
 * that has since been hidden, or one that sits above the caller's trust tier,
 * drops out server-side while its row stays. That is why the merge only ever
 * adds and never removes.
 */
export const fetchSavedCampsitesRemote = async (): Promise<Campsite[] | null> => {
  if (!supabase) return null;

  const uid = await currentUserId();
  if (!uid) return null;

  const { data, error } = await supabase.rpc('campsites_saved');
  if (error || !Array.isArray(data)) return null;

  return data.flatMap((row: any) => mapCampsiteRow(row, uid));
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

/**
 * Takes the whole Campsite, not just an id.
 *
 * `ensureCampsiteExists` needs the name and position to materialise an
 * OpenStreetMap site, and threading those through separately is how the two
 * drift apart.
 */
export const checkIn = async (
  site: Campsite,
  capacity: 'empty' | 'light' | 'busy' | 'full' | 'unknown',
  rigType?: RigType | null,
  notes?: string
): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to check in');

  const ready = await ensureCampsiteExists(site);
  if (!ready.ok) return failure(ready.message);

  const { error } = await supabase.from('check_ins').insert({
    user_id: uid,
    campsite_id: site.id,
    capacity,
    rig_type: rigType ?? null,
    notes: notes ?? null
  });
  if (error) return failure(error.message);

  /**
   * The campsite's own capacity_status is maintained by a trigger on
   * check_ins (migration 10), not from here.
   *
   * This used to be a `.update()` on public.campsites that ignored its own
   * error — and there is no UPDATE policy or grant on that table for
   * `authenticated`, so it never once succeeded. Every pin showed "Unknown"
   * capacity for as long as the feature existed.
   */
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