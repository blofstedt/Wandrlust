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
import type {
  Campsite, CamperReview,
  BeaconSpot, BeaconDwellState, BeaconOutcome, BeaconVerificationAnswers,
  BeaconModelSummary, BeaconTier, SpotVisitReport, SpotRemovalState
} from '../types';

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
  /** A `poi_kind` enum value. Mapped to a `FacilityKind` by config/facilities. */
  kind: string;
  /**
   * Null on most of them, and that is correct rather than missing data — a
   * vault toilet on a forest road has no name. The form stopped demanding one.
   */
  name: string | null;
  detail: string | null;
  latitude: number;
  longitude: number;
  is_free: boolean | null;
  price_cents: number | null;
  /**
   * `pending` until five net upvotes. Pending rows ARE returned and ARE drawn
   * — hollow, and labelled as unconfirmed. See `fetchPoisNear`.
   */
  status: 'pending' | 'promoted' | 'pruned';
  upvotes: number;
  downvotes: number;
  created_at: string;
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

/**
 * The signed-in user's id, resolved once per session rather than per call.
 *
 * `auth.getUser()` is a round trip to the auth server, and roughly
 * twenty-five exported functions in this file open by asking who the caller
 * is. Opening a spot's sheet used to mean several of those in a row, each
 * paying that trip, for an answer that does not change while the user is
 * looking at the screen.
 *
 * The cache is invalidated by the auth listener below, not by a timer, so
 * signing out or a token refresh into a different account is reflected
 * immediately. Nothing here is a security boundary — Row Level Security
 * decides what this id can actually read or write, and it reads the JWT,
 * not this variable.
 */
let cachedUserId: string | null = null;
let userIdResolved = false;

supabase?.auth.onAuthStateChange((_event, session) => {
  cachedUserId = session?.user?.id ?? null;
  userIdResolved = true;
});

const currentUserId = async (): Promise<string | null> => {
  if (!supabase) return null;
  if (userIdResolved) return cachedUserId;

  // First call of the session. getSession() reads the stored session and
  // refreshes it if needed, without a round trip per caller.
  const { data } = await supabase.auth.getSession();
  cachedUserId = data?.session?.user?.id ?? null;
  userIdResolved = true;
  return cachedUserId;
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
    submittedByMe: Boolean(uid) && row.submitted_by === uid,
    submittedBy: typeof row.submitted_by === 'string' ? row.submitted_by : undefined
  }];
};

/* ------------------------------------------------------------------ */
/* Who put a spot on the map                                           */
/* ------------------------------------------------------------------ */

/**
 * The camper behind a submission, for the byline on a spot's detail sheet.
 *
 * WHAT THIS DELIBERATELY DOES NOT RETURN. No email, no account id, nothing
 * that identifies a person off this app. `profiles` is world-readable by
 * design — it is the handle people chose to be known by — and the handle is
 * the most this is allowed to show. A camper who has set no display name is
 * credited by handle, and one the lookup cannot find is credited as "a camper",
 * which is true and is better than a blank where an author should be.
 *
 * Cached for the session: a sheet reopened ten times is one lookup, and the
 * name behind an id does not change while somebody is reading a map.
 *
 * Returns null only when there is nothing to say — no Supabase, no id, or the
 * lookup failed. The caller draws no byline at all rather than inventing one.
 */
const authorCache = new Map<string, string | null>();

export const fetchSpotAuthor = async (userId: string): Promise<string | null> => {
  if (!supabase || !userId) return null;

  const hit = authorCache.get(userId);
  if (hit !== undefined) return hit;

  const { data, error } = await supabase
    .from('profiles')
    .select('handle, display_name')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) {
    // NOT cached. A failed lookup is a moment on the network, and remembering
    // it would leave the spot unattributed for the rest of the session.
    return null;
  }

  const name =
    (typeof data.display_name === 'string' && data.display_name.trim()) ||
    (typeof data.handle === 'string' && data.handle.trim()) ||
    null;

  authorCache.set(userId, name);
  return name;
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

  /**
   * ---------------------------------------------------------------------------
   * EMPTY STRING, NEVER NULL. THIS IS WHY NO SPOT EVER REACHED THE SERVER.
   * ---------------------------------------------------------------------------
   *
   * `land_manager`, `nearest_city`, `state_province`, `country` and
   * `description` are all NOT NULL with a default of `''`. These five were
   * being sent as `|| null`, and an explicit NULL does not fall back to a
   * column default — it is a not-null violation. So every submission from a
   * spot without a land manager, which is every spot added from the map, came
   * back
   *
   *     23502 null value in column "land_manager" violates not-null constraint
   *
   * and the app did exactly what it is built to do with a failed share: kept
   * the pin on the device and said "Saved on this device". Quietly, every time,
   * since the day submissions were wired up. The live database holds twenty-one
   * seeded campsites and not one user row.
   *
   * The knock-on is the reason this was reported as something else entirely. A
   * spot that never reaches the server has no `submitted_by`, so the server
   * cannot say the spot is yours, so the Remove control is never drawn — and
   * "I can't delete my own spots" is the symptom of a submission that failed
   * hours earlier.
   *
   * The amenity columns are still OMITTED rather than sent — that is the
   * separate, deliberate decision documented above, and it works because an
   * omitted column DOES take its default. Only explicit NULLs are the problem.
   */
  const { error } = await supabase.from('campsites').insert({
    id: site.id,
    name: site.name,
    land_type: site.landType,
    land_manager: site.landManager ?? '',
    latitude: site.latitude,
    longitude: site.longitude,
    nearest_city: site.address?.nearestCity ?? '',
    state_province: site.address?.stateProvince ?? '',
    country: site.address?.country ?? '',
    description: site.description ?? '',
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
/* Taking a spot back down                                             */
/* ------------------------------------------------------------------ */

/**
 * The lookup did not happen. Nothing below is a finding — see `asked`.
 *
 * Carries the reason as the message, so a sheet that cannot offer the button
 * can still tell the camper why rather than leaving a blank where a control
 * used to be.
 */
export const NO_REMOVAL: SpotRemovalState = {
  asked: false,
  exists: false, mine: false, removable: false, others: 0,
  message:
    'Could not check with the server whether this one is still yours to take ' +
    'down. Nothing has been changed.'
};

/** The RPC's jsonb, in the app's shape. Anything unexpected reads as "no". */
const asRemovalState = (row: unknown): SpotRemovalState => {
  const r = (row ?? {}) as Record<string, unknown>;
  return {
    asked: true,
    exists: r.exists === true,
    mine: r.mine === true,
    removable: r.removable === true,
    others: Number(r.others ?? 0),
    message: (r.message as string) ?? ''
  };
};

/**
 * May the signed-in camper take this campsite back down?
 *
 * Asked before the button is drawn rather than after it is pressed — see
 * `SpotRemovalState`. `exists: false` means the server has never heard of this
 * id, which is what a spot added offline or signed-out looks like; the caller
 * treats that as "yours, on this device, remove it there".
 */
export const fetchCampsiteRemovalState = async (
  campsiteId: string
): Promise<SpotRemovalState> => {
  if (!supabase) return NO_REMOVAL;

  const { data, error } = await supabase.rpc('campsite_removal_state', {
    in_id: campsiteId
  });
  if (error) return NO_REMOVAL;

  return asRemovalState(data);
};

/**
 * Delete a campsite the caller submitted.
 *
 * The server re-checks ownership and that nobody else has touched it, so a
 * refusal here is a real answer and its message is written to be shown as-is.
 * Returning ok with `removed: false` means there was no server row to delete —
 * the device copy was the only copy, and the caller has already dealt with it.
 */
export const removeMyCampsite = async (
  campsiteId: string
): Promise<Result<{ removed: boolean }>> => {
  if (!supabase) return success({ removed: false });

  const { data, error } = await supabase.rpc('withdraw_my_campsite', {
    in_id: campsiteId
  });

  if (error) return failure('Could not reach the server just now. Nothing was removed.');

  const row = (data ?? {}) as Record<string, unknown>;
  const message = (row.message as string) ?? '';

  return row.ok === true
    ? success({ removed: row.removed === true }, message)
    : failure(message || 'That spot could not be taken down.');
};

/**
 * The same question about a Beacon spot.
 *
 * Only ever true for a spot the caller themselves put on the map. A lead the
 * scan found belongs to nobody, and one camper deciding a lead is no good is
 * what the report scales are for — not grounds to delete it for everyone.
 */
export const fetchBeaconRemovalState = async (
  spotId: string
): Promise<SpotRemovalState> => {
  if (!supabase) return NO_REMOVAL;

  const { data, error } = await supabase.rpc('beacon_spot_removal_state', {
    in_spot: spotId
  });
  if (error) return NO_REMOVAL;

  return asRemovalState(data);
};

/**
 * Take down a Beacon spot the caller added.
 *
 * Deliberately NOT `reportBeaconSpot`. That one is the knock path: it records
 * enforcement and turns the pin red for everyone. This is a camper tidying up
 * their own pin, which is a different fact, and recording it as the other one
 * would put a police warning on a place where nothing happened.
 */
export const removeMyBeaconSpot = async (
  spotId: string,
  reason?: string
): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');

  const { data, error } = await supabase.rpc('beacon_withdraw_my_spot', {
    in_spot: spotId,
    in_reason: reason ?? null
  });

  if (error) return failure('Could not reach the server just now. Nothing was removed.');

  const row = (data ?? {}) as Record<string, unknown>;
  const message = (row.message as string) ?? '';

  return row.ok === true
    ? success(true, message)
    : failure(message || 'That spot could not be taken down.');
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

/**
 * Add a facility other campers can use.
 *
 * THROUGH THE RPC, NOT THE TABLE, and that change is the whole reason a
 * camper has never been paid for one. `points_rules` has carried
 * ('poi_submit', 25, cap 2) since migration 02, but this function used to
 * `insert` straight into `pois` — and points are server-side only (house
 * rule 6), so a direct insert cannot grant them. `submit_poi` does the insert
 * and the capped grant in one place, which is also the only place that can.
 *
 * `duplicate` comes back true when the same kind is already logged at the
 * same coordinate. That is not a failure — it is somebody tapping twice, or
 * two campers logging one toilet — so it returns `ok` with its own sentence.
 */
export const submitPoi = async (poi: {
  kind: string;
  name?: string;
  lat: number;
  lon: number;
  detail?: string;
  isFree?: boolean;
}): Promise<Result<{ id: string | null; duplicate: boolean }>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to add a facility');

  const { data, error } = await supabase.rpc('submit_poi', {
    in_kind: poi.kind,
    in_lat: poi.lat,
    in_lon: poi.lon,
    in_name: poi.name?.trim() || null,
    in_detail: poi.detail?.trim() || null,
    in_free: poi.isFree ?? null
  });

  if (error) {
    return failure('Could not send that just now. Nothing was lost — try again in a moment.');
  }

  const row = data as { ok?: boolean; id?: string; duplicate?: boolean; message?: string } | null;
  return row?.ok === true
    ? success(
        { id: row.id ?? null, duplicate: row.duplicate === true },
        row.message ?? 'Added.'
      )
    : failure(row?.message || 'That did not go through.');
};

/**
 * Confirm a facility is there, or say it is gone.
 *
 * This is what finally fires `poi_lifecycle()` — the promote-at-five,
 * prune-after-three trigger has been armed and unreachable since migration
 * 02, because nothing ever wrote a vote.
 */
export const votePoi = async (poiId: string, isUpvote: boolean): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to confirm a facility');

  const { data, error } = await supabase.rpc('vote_poi', {
    in_poi_id: poiId,
    in_upvote: isUpvote
  });

  if (error) {
    return failure('Could not send that just now. Nothing was lost — try again in a moment.');
  }

  const row = data as { ok?: boolean; message?: string } | null;
  return row?.ok === true
    ? success(true, row.message ?? 'Thanks — confirmed.')
    : failure(row?.message || 'That did not go through.');
};

/**
 * Camper-added facilities near a point.
 *
 * THE BUG THIS FIXES. The previous read was `select('*')` on a table whose
 * position is a PostGIS `geom`, and PostgREST serves that column as EWKB hex
 * — so `latitude` and `longitude` were never numbers, they were absent, and
 * every row was unplottable. Nothing rendered them, so nothing broke; the
 * moment a map layer consumed them it would have. Migration 09 fixed exactly
 * this for hazard reports and spelled out that `pois` was the same case; this
 * is that fix, arriving with the layer that needed it.
 *
 * Pending rows come back on purpose. A facility hidden until five people
 * upvote it is a facility nobody can ever upvote — the map draws these hollow
 * and says in words that one camper added it and nobody else has agreed.
 *
 * An empty list means nobody has recorded one nearby. It NEVER means there is
 * nothing there.
 */
export const fetchPoisNear = async (
  latitude: number,
  longitude: number,
  radiusKm = 25
): Promise<PoiRecord[]> => {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('pois_near', {
    in_lat: latitude,
    in_lon: longitude,
    in_radius_km: radiusKm
  });
  if (error || !Array.isArray(data)) return [];
  return ok(data as PoiRecord[], []);
};

/**
 * CAMPER NOTES ON FACILITIES, BY AREA.
 *
 * A note is directions — "behind the yellow wall, at the back" — not a review
 * and not a vote. It attaches to a camper's `pois` row OR to an OpenStreetMap
 * node id, because the thing worth writing down is worth writing down whichever
 * of the two put the pin on the screen.
 *
 * Read by area like every other geometry in this schema, and readable signed
 * out: somebody with no account is exactly who most needs to be told which door
 * the tap is behind.
 */
export interface PoiNoteRecord {
  id: string;
  poi_id: string | null;
  osm_id: string | null;
  body: string;
  author: string;
  author_name: string;
  created_at: string;
}

export const fetchPoiNotesNear = async (
  latitude: number,
  longitude: number,
  radiusKm = 25
): Promise<PoiNoteRecord[]> => {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('poi_notes_near', {
    in_lat: latitude,
    in_lon: longitude,
    in_radius_km: radiusKm
  });
  if (error || !Array.isArray(data)) return [];
  return ok(data as PoiNoteRecord[], []);
};

/**
 * Leave one, or replace your own.
 *
 * A second note from the same camper about the same facility is an EDIT —
 * somebody correcting their own directions — and the function upserts rather
 * than refusing. Two versions of one person's directions on one pin is a map
 * arguing with itself.
 */
export const addPoiNote = async (note: {
  poiId?: string | null;
  osmId?: string | null;
  lat: number;
  lon: number;
  body: string;
}): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to leave a note');

  const { data, error } = await supabase.rpc('add_poi_note', {
    in_poi_id: note.poiId ?? null,
    in_osm_id: note.osmId ?? null,
    in_lat: note.lat,
    in_lon: note.lon,
    in_body: note.body
  });
  if (error) return failure(error.message);

  const row = data as { ok?: boolean; message?: string } | null;
  return row?.ok === true
    ? success(true, row.message ?? 'Note added.')
    : failure(row?.message || 'That did not go through.');
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

/* ------------------------------------------------------------------ */
/* Push subscriptions                                                  */
/* ------------------------------------------------------------------ */

export const upsertPushSubscription = async (subscription: {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string;
}): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');
  const uid = await currentUserId();
  if (!uid) return failure('Sign in to receive alerts');

  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: uid,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      user_agent: subscription.userAgent,
      last_seen_at: new Date().toISOString(),
      failure_count: 0
    },
    { onConflict: 'endpoint' }
  );

  return error ? failure(error.message) : success(true, 'Subscribed');
};

export const removePushSubscription = async (endpoint: string): Promise<void> => {
  if (!supabase) return;
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
};

/**
 * Keep the server's idea of where a signed-in camper roughly is, so
 * location-scoped alerts can be targeted without tracking anyone
 * continuously. `pushService.ts` rounds the coordinates to ~1 km before they
 * ever reach here.
 */
export const updateAlertLocation = async (coarseLat: number, coarseLon: number): Promise<void> => {
  if (!supabase) return;
  const uid = await currentUserId();
  if (!uid) return;

  await supabase
    .from('user_settings')
    .upsert(
      {
        user_id: uid,
        alert_lat: coarseLat,
        alert_lon: coarseLon,
        alert_location_updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id' }
    );
};

/* ------------------------------------------------------------------ */
/* Beacon                                                              */
/* ------------------------------------------------------------------ */

/**
 * Beacon spots near a point.
 *
 * Positions come back projected to numbers by the RPC — never select `geom`
 * directly, PostgREST serves it as EWKB hex. Spots that are genuinely gone are
 * filtered out in SQL; spots somebody got a knock at deliberately are NOT, and
 * arrive with `tier: 'flagged'` so the map can draw them red.
 */
export const fetchBeaconSpotsNear = async (
  lat: number,
  lon: number,
  radiusKm = 25
): Promise<BeaconSpot[]> => {
  if (!supabase) return [];

  const { data, error } = await supabase.rpc('beacon_spots_near', {
    in_lat: lat,
    in_lon: lon,
    in_radius_km: radiusKm
  });
  if (error || !Array.isArray(data)) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    tier: row.tier as BeaconSpot['tier'],
    generator: row.generator as BeaconSpot['generator'],
    label: (row.label as string) ?? 'Possible spot',
    landBasis: (row.land_basis as string) ?? undefined,
    signEvidence: row.sign_evidence as BeaconSpot['signEvidence'],
    verifyCount: Number(row.verify_count ?? 0),
    score: Number(row.rule_score ?? 0) + Number(row.model_score ?? 0),
    region: (row.region as string) ?? '*',
    knock: Number(row.knock_count ?? 0) > 0
      ? {
          reportedAt: (row.last_knock_at as string) ?? '',
          comment: (row.last_knock_note as string) ?? undefined,
          count: Number(row.knock_count ?? 0)
        }
      : undefined,
    conditions: {
      // `numberOrUndefined` and not `Number(x ?? 0)`. A null average means
      // nobody answered that question, and turning it into a zero would put
      // "pitch black, no view, sloped" on every spot nobody has rated.
      crowding: numberOrUndefined(row.avg_crowding),
      rating: numberOrUndefined(row.avg_rating),
      view: numberOrUndefined(row.avg_view),
      maxRig: numberOrUndefined(row.avg_max_rig),
      roadAccess: numberOrUndefined(row.avg_road_access),
      levelGround: numberOrUndefined(row.avg_level_ground),
      shade: numberOrUndefined(row.avg_shade),
      nightLight: numberOrUndefined(row.avg_night_light),
      cellBars: numberOrUndefined(row.avg_cell_bars),
      sampleSize: Number(row.visit_count ?? 0)
    }
  }));
};

/** null, undefined and NaN all mean "nobody answered". Zero does not. */
const numberOrUndefined = (value: unknown): number | undefined => {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Report on a spot the camper is standing at.
 *
 * The quick path: no four-hour dwell, just a photo and a position inside
 * 150 m. Every check that decides anything runs in `beacon_submit_visit` —
 * the distance, the one-report-per-camper rule, the impossible-trip check and
 * the tier promotion. This passes the answers over and returns the sentence
 * the database wrote.
 */
export const submitSpotVisit = async (
  spotId: string,
  lat: number,
  lon: number,
  accuracyM: number | undefined,
  report: SpotVisitReport,
  clientFlags: Record<string, unknown> = {}
): Promise<Result<{ tier: BeaconTier; verifiers: number }>> => {
  if (!supabase) return failure('Not connected');

  const { data, error } = await supabase.rpc('beacon_submit_visit', {
    in_spot: spotId,
    in_lat: lat,
    in_lon: lon,
    in_accuracy: accuracyM ?? null,
    in_report: report,
    in_flags: clientFlags
  });

  if (error) return failure('Could not send that just now. Nothing was lost — try again in a moment.');

  const row = (data ?? {}) as Record<string, unknown>;
  const message = (row.message as string) ?? '';

  return row.ok === true
    ? success(
        {
          tier: (row.tier as BeaconTier) ?? 'reported',
          verifiers: Number(row.verifiers ?? 0)
        },
        message
      )
    : failure(message || 'That did not go through.');
};

/**
 * Put a brand-new spot on the map.
 *
 * If somebody else's pin is already within 40 m, the database treats this as a
 * report on THAT spot rather than stacking a second pin on the same pullout,
 * and says so via `merged`. The caller shows a different sentence in that case
 * — silently merging without saying so makes it look like the submission was
 * lost.
 */
export const createSpot = async (
  lat: number,
  lon: number,
  label: string,
  basis: string | undefined,
  accuracyM: number | undefined,
  report: SpotVisitReport,
  clientFlags: Record<string, unknown> = {}
): Promise<Result<{ spotId: string; merged: boolean; tier: BeaconTier }>> => {
  if (!supabase) return failure('Not connected');

  const { data, error } = await supabase.rpc('beacon_create_spot', {
    in_lat: lat,
    in_lon: lon,
    in_label: label,
    in_basis: basis ?? null,
    in_accuracy: accuracyM ?? null,
    in_report: report,
    in_flags: clientFlags
  });

  if (error) return failure('Could not add that spot just now.');

  const row = (data ?? {}) as Record<string, unknown>;
  const message = (row.message as string) ?? '';

  return row.ok === true
    ? success(
        {
          spotId: String(row.spot_id ?? ''),
          merged: row.merged === true,
          tier: (row.tier as BeaconTier) ?? 'reported'
        },
        message
      )
    : failure(message || 'That did not go through.');
};

/**
 * Upload a photo that other campers will see.
 *
 * A DIFFERENT bucket from `uploadBeaconProof`. That one is private evidence
 * nobody browses; this one is public content, which is the whole reason
 * somebody attaches it. The report sheet says which is which before they
 * submit — discovering afterwards that your photo is public is not a surprise
 * anybody should get.
 */
export const uploadSpotPhoto = async (
  file: File
): Promise<Result<string>> => {
  if (!supabase) return failure('Not connected');

  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) return failure('Sign in to add a photo.');

  // The bucket policy requires the first path segment to be the caller's own
  // id, so this is not decoration — a different prefix is rejected outright.
  const extension = (file.name.split('.').pop() ?? 'jpg').toLowerCase().slice(0, 4);
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;

  const { error } = await supabase.storage
    .from('spot-photos')
    .upload(path, file, { cacheControl: '3600', upsert: false });

  if (error) return failure('That photo did not upload. Check your connection.');
  return success(path, 'Photo added');
};

/** The public URL for a stored spot photo. Empty string when not configured. */
export const spotPhotoUrl = (path: string): string => {
  if (!supabase || !path) return '';
  return supabase.storage.from('spot-photos').getPublicUrl(path).data.publicUrl ?? '';
};

/**
 * Log where the camper is right now, at a spot they intend to vouch for.
 *
 * The server does every check that matters — inside the 50 m fence, plausible
 * accuracy, no impossible travel since the last ping — because a browser has
 * no mock-location flag to read and anything checked here could be edited by
 * whoever is faking the position in the first place.
 */
export const recordBeaconPing = async (
  spotId: string,
  lat: number,
  lon: number,
  accuracyM?: number
): Promise<BeaconDwellState> => {
  if (!supabase) {
    return { ok: false, dwellMinutes: 0, ready: false, message: 'Not connected' };
  }

  const { data, error } = await supabase.rpc('beacon_record_ping', {
    in_spot: spotId,
    in_lat: lat,
    in_lon: lon,
    in_accuracy: accuracyM ?? null,
    in_flags: {}
  });

  if (error || !data) {
    return {
      ok: false, dwellMinutes: 0, ready: false,
      message: 'Could not reach the server to log your check-in.'
    };
  }

  const row = data as Record<string, unknown>;
  return {
    ok: row.ok === true,
    distanceM: typeof row.distance_m === 'number' ? row.distance_m : undefined,
    arrivedAt: (row.arrived_at as string) ?? undefined,
    dwellMinutes: Number(row.dwell_minutes ?? 0),
    ready: row.ready === true,
    message: (row.message as string) ?? undefined
  };
};

/**
 * Vouch for a spot after a four-hour stay.
 *
 * Everything is decided in SQL: the dwell span, the geofence, the one-per-camper
 * rule, and the tier promotion. This function's only job is to hand over what
 * the camper typed and pass back the sentence the database wrote.
 */
export const submitBeaconVerification = async (
  spotId: string,
  lat: number,
  lon: number,
  accuracyM: number | undefined,
  photoPath: string,
  answers: BeaconVerificationAnswers,
  /** The same rich report a quick visit carries, marked as an overnight stay. */
  report: SpotVisitReport = {}
): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');

  const { data, error } = await supabase.rpc('beacon_submit_verification', {
    in_spot: spotId,
    in_lat: lat,
    in_lon: lon,
    in_accuracy: accuracyM ?? null,
    in_photo_path: photoPath,
    in_answers: answers,
    in_report: { ...report, stayedOvernight: true }
  });

  if (error) return failure('Could not save that just now. Your stay is still logged.');

  const row = (data ?? {}) as Record<string, unknown>;
  const message = (row.message as string) ?? '';
  return row.ok === true ? success(true, message) : failure(message || 'That did not go through.');
};

/**
 * Take a spot off the map.
 *
 * One report is enough and there is no confirmation step, by design: the cost
 * of being wrong is a camper losing one possible place to sleep, and the cost
 * of being slow is another camper getting the ticket this one just got.
 */
export const reportBeaconSpot = async (
  spotId: string,
  outcome: BeaconOutcome,
  detail?: string
): Promise<Result<boolean>> => {
  if (!supabase) return failure('Not connected');

  const { data, error } = await supabase.rpc('beacon_report_spot', {
    in_spot: spotId,
    in_outcome: outcome,
    in_detail: detail ?? null
  });

  if (error) return failure('Could not send that report just now.');

  const row = (data ?? {}) as Record<string, unknown>;
  const message = (row.message as string) ?? '';
  return row.ok === true ? success(true, message) : failure(message || 'That did not go through.');
};

/**
 * What the ranking model has learned, for the region a camper is looking at.
 *
 * Shown in the Beacon panel. A ranking nobody can inspect is a ranking nobody
 * should trust, and "learned from 14 stays around here" is also the honest way
 * to say "so do not lean on this yet".
 */
export const fetchBeaconModelSummary = async (
  region?: string
): Promise<BeaconModelSummary | null> => {
  if (!supabase) return null;

  const { data, error } = await supabase.rpc('beacon_model_summary', {
    in_region: region ?? '*'
  });
  if (error || !data) return null;

  const row = data as Record<string, unknown>;
  return {
    region: (row.region as string) ?? '*',
    stays_recorded: Number(row.stays_recorded ?? 0),
    reports_recorded: Number(row.reports_recorded ?? 0),
    observations_here: Number(row.observations_here ?? 0),
    trusts_most: Array.isArray(row.trusts_most) ? (row.trusts_most as string[]) : [],
    trusts_least: Array.isArray(row.trusts_least) ? (row.trusts_least as string[]) : []
  };
};

/**
 * Store the proof photo and hand back its path.
 *
 * The bucket is private and foldered by user id, which is what the storage
 * policy in migration 13 keys on — change the path shape here and the upload
 * starts failing with a permissions error rather than a useful one.
 */
export const uploadBeaconProof = async (
  spotId: string,
  file: Blob
): Promise<Result<string>> => {
  if (!supabase) return failure('Not connected');

  const uid = await currentUserId();
  if (!uid) return failure('Not signed in');

  const path = `${uid}/${spotId}-${Date.now()}.jpg`;
  const { error } = await supabase.storage
    .from('beacon-proof')
    .upload(path, file, { contentType: 'image/jpeg', upsert: false });

  if (error) return failure('Could not upload that photo. Try again with a smaller one.');
  return success(path, '');
};

/**
 * The caller's access token, for the one API route that has to check a quota
 * against a real identity.
 *
 * `/api/beacon/query` claims a rate-limit token with the CALLER's credentials
 * rather than trusting the browser to say who it is — otherwise three beacons
 * per twelve hours would be a polite suggestion. This is the only place that
 * hands a token out, so beaconService never needs to import the Supabase
 * client itself.
 */
export const currentAccessToken = async (): Promise<string | null> => {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token ?? null;
};

/**
 * Make the app agree with the server about whether anybody is signed in.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 *
 * `AuthContext` sets `user` from the session it read at startup. If that
 * session later dies and the refresh cannot save it, Supabase hands back no
 * session — but nothing had told the React tree, so `user` stayed truthy for
 * the rest of the app's life. Beacon's panel checks `user`, believed the
 * camper was signed in, and sent a request with no token on it. The server
 * answered 401 "sign in to send out a beacon", the panel printed that
 * sentence, and a camper who was looking at their own name in the account
 * menu read it as the feature being broken and pressed the button again.
 * Seven times in fifteen seconds, in the logs that found this.
 *
 * Signing out for real is what fixes it: it fires `onAuthStateChange`,
 * `AuthContext` clears `user`, and every gate in the app starts telling the
 * same story. The camper is signed out either way — this only stops the app
 * pretending otherwise.
 */
export const signOutStaleSession = async (): Promise<void> => {
  if (!supabase) return;
  try {
    const { data } = await supabase.auth.getSession();
    if (!data?.session) await supabase.auth.signOut();
  } catch {
    // Best effort. A failure here leaves the app exactly as it was.
  }
};
