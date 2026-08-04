-- =====================================================================
--  Wandrlust — Migration 02: Social, Tokens, Trust, Telemetry, POIs
--
--  Run AFTER supabase_schema.sql. Additive.
--
--  ------------------------------------------------------------------
--  ONE THING DELIBERATELY NOT BUILT
--
--  A "behavioural shadowban" that detects law enforcement patterns and
--  quietly serves those accounts a falsified feed is NOT implemented.
--
--  Practical: the proposed signal (high look-to-stay ratio + spatial
--  overlap) describes trip planners, researchers, and anyone browsing
--  before a trip. It would misfire far more often than it fired
--  correctly, and every false positive is a real user silently served
--  bad data with no way to tell.
--
--  What IS implemented addresses the actual threat — good spots getting
--  burned by mass harvesting:
--    * scrape_guard  — behaviour-based, identity-blind throttling.
--    * Tier gating   — exact coordinates require earned trust (§8).
--    * Unlock ledger — every reveal recorded, blast radius auditable.
--  ------------------------------------------------------------------
-- =====================================================================

begin;

create extension if not exists postgis;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------
drop type if exists public.rig_type          cascade;
drop type if exists public.presence_status   cascade;
drop type if exists public.visibility_mode   cascade;
drop type if exists public.trust_tier        cascade;
drop type if exists public.token_reason      cascade;
drop type if exists public.burn_reason       cascade;
drop type if exists public.hazard_kind       cascade;
drop type if exists public.surface_quality   cascade;
drop type if exists public.poi_kind          cascade;
drop type if exists public.poi_status        cascade;
drop type if exists public.booking_status    cascade;
drop type if exists public.friendship_status cascade;
drop type if exists public.capacity_status   cascade;

create type public.rig_type as enum (
  'tent', 'car', 'suv', 'van', 'truck_camper', 'travel_trailer',
  'fifth_wheel', 'class_a', 'class_b', 'class_c', 'skoolie', 'overland_rig'
);

create type public.presence_status as enum ('in_transit', 'scouting', 'parked', 'offline');

-- Ghost mode is the safe default everywhere it appears.
create type public.visibility_mode as enum ('ghost', 'friends', 'public');

create type public.trust_tier as enum ('tourist', 'contributor', 'nomad');

create type public.token_reason as enum (
  'check_in', 'check_out', 'scout_new_site', 'verify_amenity',
  'telemetry_batch', 'hazard_report', 'early_hazard_bonus',
  'photo_upload', 'poi_submit', 'mutual_review_bonus', 'host_stay',
  'unlock_stealth', 'book_stay', 'download_map_pack',
  'admin_grant', 'admin_clawback'
);

-- Deliberately neutral: describes the site's condition, not people.
create type public.burn_reason as enum (
  'physical_barrier', 'posted_closure', 'enforcement_contact',
  'environmental_hazard', 'overcrowded', 'private_property',
  'access_road_impassable', 'other'
);

create type public.hazard_kind as enum (
  'washout', 'debris', 'deep_mud', 'snow_drift', 'downed_tree',
  'low_clearance', 'weak_bridge', 'flooding', 'fire_activity',
  'enforcement_activity', 'wildlife', 'other'
);

create type public.surface_quality as enum (
  'smooth_paved', 'rough_paved', 'good_gravel',
  'washboard', 'rutted_dirt', 'rock_crawl', 'impassable'
);

create type public.poi_kind as enum (
  'potable_water', 'dump_station', 'propane', 'fuel', 'shower',
  'laundry', 'trash', 'air_compressor', 'cell_booster_spot', 'other'
);

create type public.poi_status as enum ('pending', 'promoted', 'pruned');

create type public.booking_status as enum (
  'requested', 'confirmed', 'cancelled', 'completed', 'no_show'
);

create type public.friendship_status as enum ('pending', 'accepted', 'blocked');

create type public.capacity_status as enum ('empty', 'light', 'busy', 'full', 'unknown');

-- =====================================================================
--  2. PROFILES & RIGS
-- =====================================================================

create table public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  handle            text unique not null,
  display_name      text,
  avatar_url        text,
  bio               text,

  -- Trust (see §8). Never client-writable.
  trust_score       integer not null default 0,
  trust_tier        public.trust_tier not null default 'tourist',

  -- Default map visibility. Ghost until the user opts in.
  default_visibility public.visibility_mode not null default 'ghost',

  check_in_count    integer not null default 0,
  scout_count       integer not null default 0,
  verify_count      integer not null default 0,

  is_host           boolean not null default false,
  is_suspended      boolean not null default false,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint profiles_handle_format check (handle ~ '^[a-z0-9_]{3,24}$'),
  constraint profiles_trust_score_floor check (trust_score >= 0)
);

comment on column public.profiles.default_visibility is
  'Defaults to ghost. Location sharing is strictly opt-in.';

create index profiles_tier_idx on public.profiles (trust_tier);

-- Rig dimensions drive clearance-aware routing.
create table public.rigs (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references public.profiles(id) on delete cascade,
  nickname            text not null default 'My rig',
  rig_type            public.rig_type not null,

  height_cm           integer,
  length_cm           integer,
  width_cm            integer,
  gross_weight_kg     integer,
  ground_clearance_cm integer,
  is_4wd              boolean not null default false,
  has_trailer         boolean not null default false,

  is_primary          boolean not null default true,
  created_at          timestamptz not null default now(),

  constraint rigs_height_sane    check (height_cm is null or height_cm between 100 and 500),
  constraint rigs_length_sane    check (length_cm is null or length_cm between 200 and 2500),
  constraint rigs_width_sane     check (width_cm is null or width_cm between 100 and 400),
  constraint rigs_weight_sane    check (gross_weight_kg is null or gross_weight_kg between 500 and 40000),
  constraint rigs_clearance_sane check (ground_clearance_cm is null or ground_clearance_cm between 5 and 100)
);

create index rigs_owner_idx on public.rigs (owner_id);
create unique index rigs_one_primary_idx on public.rigs (owner_id) where is_primary;

-- =====================================================================
--  3. FRIENDSHIPS
-- =====================================================================

create table public.friendships (
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status       public.friendship_status not null default 'pending',
  created_at   timestamptz not null default now(),
  responded_at timestamptz,

  primary key (requester_id, addressee_id),
  constraint friendships_no_self check (requester_id <> addressee_id)
);

create index friendships_addressee_idx on public.friendships (addressee_id, status);

create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = a and f.addressee_id = b)
        or (f.requester_id = b and f.addressee_id = a))
  );
$$;

-- =====================================================================
--  4. PRESENCE
--
--  Privacy model:
--    * Precise geometry is readable ONLY by its owner. RLS enforces this.
--    * Everyone else reads through nearby_campers(), which snaps
--      positions to a ~1 km grid before returning them.
--    * Ghost rows are never returned to anyone but the owner.
--    * Rows self-expire; stale presence is not location history.
-- =====================================================================

create table public.presence (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  geom        geometry(Point, 4326) not null,
  status      public.presence_status not null default 'parked',
  rig_type    public.rig_type,
  visibility  public.visibility_mode not null default 'ghost',
  heading_deg smallint,
  note        text,
  updated_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '4 hours'),

  constraint presence_heading_range check (heading_deg is null or heading_deg between 0 and 359),
  constraint presence_note_len check (note is null or length(note) <= 140)
);

create index presence_geom_idx   on public.presence using gist (geom);
create index presence_expiry_idx on public.presence (expires_at);

comment on table public.presence is
  'Ephemeral. Precise coords are owner-readable only; others get grid-snapped positions via nearby_campers().';

-- Snap to a ~1 km grid so a shared position cannot identify a campsite.
create or replace function public.coarsen_point(g geometry, grid_deg double precision default 0.01)
returns geometry language sql immutable as $$
  select st_setsrid(
    st_makepoint(
      round((st_x(g) / grid_deg)::numeric)::double precision * grid_deg,
      round((st_y(g) / grid_deg)::numeric)::double precision * grid_deg
    ), 4326);
$$;

create or replace function public.nearby_campers(
  in_lat double precision, in_lon double precision, in_radius_km double precision default 50
)
returns table (
  user_id uuid, handle text, status public.presence_status, rig_type public.rig_type,
  note text, approx_lat double precision, approx_lon double precision, updated_at timestamptz
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select
    p.user_id, pr.handle, p.status, p.rig_type, p.note,
    st_y(public.coarsen_point(p.geom)), st_x(public.coarsen_point(p.geom)), p.updated_at
  from public.presence p
  join public.profiles pr on pr.id = p.user_id
  where p.expires_at > now()
    and p.visibility <> 'ghost'
    and (
      p.visibility = 'public'
      or (p.visibility = 'friends' and public.are_friends(auth.uid(), p.user_id))
    )
    and p.user_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
    and st_dwithin(
          p.geom::geography,
          st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography,
          least(in_radius_km, 200) * 1000
        )
  limit 300;
$$;

create or replace function public.purge_expired_presence()
returns integer language plpgsql security definer
set search_path = public, pg_temp
as $$
declare n integer;
begin
  delete from public.presence where expires_at < now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- =====================================================================
--  5. TOKEN ECONOMY
--
--  Closed loop by construction:
--    * Append-only ledger. No UPDATE or DELETE policy for anyone.
--    * No cash-out path, no payout table, no external transfer column.
--    * spend_tokens() refuses to overdraw.
--
--  Keep it that way. The moment tokens become redeemable for money, this
--  stops being a points system and starts being a regulated one.
-- =====================================================================

create table public.token_ledger (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  delta      integer not null,
  reason     public.token_reason not null,
  ref_table  text,
  ref_id     text,
  memo       text,
  created_at timestamptz not null default now(),

  constraint token_ledger_delta_nonzero check (delta <> 0),
  constraint token_ledger_delta_sane    check (delta between -10000 and 10000)
);

create index token_ledger_user_idx on public.token_ledger (user_id, created_at desc);

create materialized view public.token_balances as
  select user_id, sum(delta)::integer as balance
  from public.token_ledger group by user_id;

create unique index token_balances_user_idx on public.token_balances (user_id);

create or replace function public.token_balance(in_user uuid)
returns integer language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(delta), 0)::integer
  from public.token_ledger where user_id = in_user;
$$;

-- Faucet. Server-side only: clients cannot mint.
create or replace function public.grant_tokens(
  in_user uuid, in_amount integer, in_reason public.token_reason,
  in_ref_table text default null, in_ref_id text default null, in_memo text default null
)
returns bigint language plpgsql security definer
set search_path = public, pg_temp
as $$
declare new_id bigint;
begin
  if in_amount <= 0 then
    raise exception 'grant_tokens requires a positive amount';
  end if;

  insert into public.token_ledger (user_id, delta, reason, ref_table, ref_id, memo)
  values (in_user, in_amount, in_reason, in_ref_table, in_ref_id, in_memo)
  returning id into new_id;

  return new_id;
end;
$$;

-- Sink. Refuses to overdraw.
create or replace function public.spend_tokens(
  in_user uuid, in_amount integer, in_reason public.token_reason,
  in_ref_table text default null, in_ref_id text default null
)
returns integer language plpgsql security definer
set search_path = public, pg_temp
as $$
declare current_balance integer;
begin
  if in_amount <= 0 then
    raise exception 'spend_tokens requires a positive amount';
  end if;

  -- Lock the PROFILE row, not the ledger: a user with no ledger rows yet
  -- would otherwise lock nothing and two concurrent spends could both pass.
  perform 1 from public.profiles where id = in_user for update;

  select coalesce(sum(delta), 0)::integer into current_balance
  from public.token_ledger where user_id = in_user;

  if current_balance < in_amount then
    raise exception 'insufficient tokens: have %, need %', current_balance, in_amount
      using errcode = 'check_violation';
  end if;

  insert into public.token_ledger (user_id, delta, reason, ref_table, ref_id)
  values (in_user, -in_amount, in_reason, in_ref_table, in_ref_id);

  return current_balance - in_amount;
end;
$$;

create table public.token_rules (
  reason      public.token_reason primary key,
  amount      integer not null,
  daily_cap   integer,
  description text
);

--
-- Caps are deliberately tight. The scarce thing in this economy is a good
-- unburned campsite, so unlocking one should cost roughly a week of genuine
-- contribution — not an afternoon of grinding.
--
-- Realistic active day (1 check-in, 1 check-out, 2 verifies, 3 telemetry
-- batches) is ~60 tokens. The 480 theoretical ceiling requires scouting a
-- virgin site AND hosting two stays AND landing three confirmed hazard
-- reports in 24 hours, which is not a grindable loop.
--
-- At 60/day: ~4 days per stealth unlock, ~8 days per private-land booking.
--
insert into public.token_rules (reason, amount, daily_cap, description) values
  ('check_in',            10,   3, 'Verified arrival at a site'),
  ('check_out',            5,   3, 'Departure with capacity report'),
  ('scout_new_site',      50,   1, 'First to document an unmapped site'),
  ('verify_amenity',      15,   3, 'Confirm or correct an amenity'),
  ('telemetry_batch',      5,   6, 'Road-surface telemetry on unmapped road'),
  ('hazard_report',       20,   3, 'Report a road hazard'),
  ('early_hazard_bonus',  30,   2, 'First reporter of a hazard others confirm'),
  ('photo_upload',        10,   3, 'Photo accepted for a site'),
  ('poi_submit',          25,   2, 'Submit infrastructure POI'),
  ('mutual_review_bonus', 10,   3, 'Both parties reviewed: 10% bonus'),
  ('host_stay',           40,   2, 'Host a stay on your private land'),
  ('unlock_stealth',    -250, null, 'Reveal exact coords of a stealth site'),
  ('book_stay',         -200, null, 'Book a private land stay'),
  ('download_map_pack',  -50, null, 'Premium offline map layer');

-- =====================================================================
--  6. ANTI-SCRAPING
--
--  Identity-blind. Measures request behaviour only. A human planning a
--  trip does not reveal 60 exact coordinates in an hour. A harvester does.
-- =====================================================================

create table public.reveal_log (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  campsite_id text not null,
  revealed_at timestamptz not null default now()
);

create index reveal_log_user_time_idx on public.reveal_log (user_id, revealed_at desc);

create table public.scrape_guard (
  user_id           uuid primary key references public.profiles(id) on delete cascade,
  window_start      timestamptz not null default now(),
  reveals_in_window integer not null default 0,
  throttled_until   timestamptz,
  reason            text
);

create or replace function public.check_reveal_quota(in_user uuid)
returns boolean language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  g public.scrape_guard%rowtype;
  hourly_cap constant integer := 25;
begin
  select * into g from public.scrape_guard where user_id = in_user for update;

  if not found then
    insert into public.scrape_guard (user_id, reveals_in_window) values (in_user, 1);
    return true;
  end if;

  if g.throttled_until is not null and g.throttled_until > now() then
    return false;
  end if;

  if g.window_start < now() - interval '1 hour' then
    update public.scrape_guard
       set window_start = now(), reveals_in_window = 1, throttled_until = null, reason = null
     where user_id = in_user;
    return true;
  end if;

  if g.reveals_in_window >= hourly_cap then
    update public.scrape_guard
       set throttled_until = now() + interval '6 hours',
           reason = format('Exceeded %s exact-location reveals in one hour', hourly_cap)
     where user_id = in_user;
    return false;
  end if;

  update public.scrape_guard set reveals_in_window = g.reveals_in_window + 1
   where user_id = in_user;
  return true;
end;
$$;

-- =====================================================================
--  7. TRUST TIERS & STEALTH SITES
-- =====================================================================

alter table public.campsites
  add column if not exists is_stealth      boolean not null default false,
  add column if not exists min_tier        public.trust_tier not null default 'tourist',
  add column if not exists submitted_by    uuid references public.profiles(id) on delete set null,
  add column if not exists capacity_status public.capacity_status not null default 'unknown',
  add column if not exists capacity_updated_at timestamptz;

create index campsites_stealth_idx on public.campsites (is_stealth, min_tier);

create table public.stealth_unlocks (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  campsite_id text not null references public.campsites(id) on delete cascade,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, campsite_id)
);

create or replace function public.tier_rank(t public.trust_tier)
returns integer language sql immutable as $$
  select case t when 'tourist' then 1 when 'contributor' then 2 when 'nomad' then 3 end;
$$;

create or replace function public.recompute_trust(in_user uuid)
returns public.trust_tier language plpgsql security definer
set search_path = public, pg_temp
as $$
declare score integer; tier public.trust_tier;
begin
  select coalesce(p.check_in_count, 0) * 3
       + coalesce(p.scout_count, 0)   * 10
       + coalesce(p.verify_count, 0)  * 2
    into score
  from public.profiles p where p.id = in_user;

  score := coalesce(score, 0);

  tier := case
    when score >= 150 then 'nomad'::public.trust_tier
    when score >= 30  then 'contributor'::public.trust_tier
    else 'tourist'::public.trust_tier
  end;

  update public.profiles
     set trust_score = score, trust_tier = tier, updated_at = now()
   where id = in_user;

  return tier;
end;
$$;

/*
 * The single read path for campsites.
 *   Tier 1 (tourist)     : public-land sites only. Stealth pins invisible.
 *   Tier 2 (contributor) : sees that a stealth pin exists, fuzzed ~2 km.
 *   Tier 3 (nomad)       : exact coords, after unlocking with tokens.
 */
create or replace function public.campsites_visible(
  in_lat double precision, in_lon double precision, in_radius_miles double precision default 100
)
returns table (
  id text, name text, land_type public.land_type,
  latitude double precision, longitude double precision,
  is_stealth boolean, is_unlocked boolean, is_approximate boolean,
  capacity_status public.capacity_status, rating numeric, distance_miles double precision
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  with caller as (
    select
      auth.uid() as uid,
      coalesce(
        (select p.trust_tier from public.profiles p where p.id = auth.uid()),
        'tourist'::public.trust_tier
      ) as tier
  ),
  candidate as (
    select
      c.*,
      exists (
        select 1 from public.stealth_unlocks u, caller
        where u.user_id = caller.uid and u.campsite_id = c.id
      ) as unlocked
    from public.campsites c, caller
    where c.is_published
      and public.tier_rank(caller.tier) >= public.tier_rank(c.min_tier)
      and st_dwithin(
            c.geom::geography,
            st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography,
            least(in_radius_miles, 500) * 1609.344
          )
  )
  select
    k.id, k.name, k.land_type,
    -- Exact coords only for non-stealth sites, or stealth sites this user
    -- has unlocked. Everything else is snapped to a ~2 km grid.
    case when (not k.is_stealth) or k.unlocked
         then k.latitude else st_y(public.coarsen_point(k.geom, 0.02)) end,
    case when (not k.is_stealth) or k.unlocked
         then k.longitude else st_x(public.coarsen_point(k.geom, 0.02)) end,
    k.is_stealth,
    k.unlocked,
    k.is_stealth and not k.unlocked as is_approximate,
    k.capacity_status,
    k.rating,
    st_distance(
      k.geom::geography,
      st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography
    ) / 1609.344 as distance_miles
  from candidate k
  order by distance_miles
  limit 300;
$$;

create or replace function public.unlock_stealth_site(in_campsite text)
returns table (latitude double precision, longitude double precision, balance integer)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  caller_tier public.trust_tier;
  cost integer;
  new_balance integer;
  site public.campsites%rowtype;
begin
  if caller is null then raise exception 'authentication required'; end if;

  select * into site from public.campsites where id = in_campsite and is_published;
  if not found then raise exception 'campsite not found'; end if;

  select trust_tier into caller_tier from public.profiles where id = caller;
  if public.tier_rank(coalesce(caller_tier, 'tourist')) < public.tier_rank('nomad') then
    raise exception 'nomad tier required to unlock exact coordinates';
  end if;

  if not public.check_reveal_quota(caller) then
    raise exception 'reveal rate limit reached; try again later'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.stealth_unlocks
              where user_id = caller and campsite_id = in_campsite) then
    return query select site.latitude, site.longitude, public.token_balance(caller);
    return;
  end if;

  select abs(amount) into cost from public.token_rules where reason = 'unlock_stealth';
  new_balance := public.spend_tokens(caller, coalesce(cost, 250), 'unlock_stealth',
                                     'campsites', in_campsite);

  insert into public.stealth_unlocks (user_id, campsite_id) values (caller, in_campsite);
  insert into public.reveal_log (user_id, campsite_id) values (caller, in_campsite);

  return query select site.latitude, site.longitude, new_balance;
end;
$$;

-- =====================================================================
--  8. CHECK-INS, BURN REPORTS, ZONE HEAT
-- =====================================================================

create table public.check_ins (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  campsite_id text not null references public.campsites(id) on delete cascade,
  arrived_at  timestamptz not null default now(),
  departed_at timestamptz,
  capacity    public.capacity_status not null default 'unknown',
  rig_type    public.rig_type,
  notes       text,
  is_private  boolean not null default false,

  constraint check_ins_departure_after check (departed_at is null or departed_at >= arrived_at),
  constraint check_ins_notes_len check (notes is null or length(notes) <= 500)
);

create index check_ins_site_idx on public.check_ins (campsite_id, arrived_at desc);
create index check_ins_user_idx on public.check_ins (user_id, arrived_at desc);

-- Site condition reports. Reason codes describe the site, not individuals.
create table public.site_reports (
  id          uuid primary key default gen_random_uuid(),
  campsite_id text not null references public.campsites(id) on delete cascade,
  user_id     uuid references public.profiles(id) on delete set null,
  reason      public.burn_reason not null,
  detail      text,
  observed_on date not null default current_date,
  created_at  timestamptz not null default now(),

  constraint site_reports_detail_len check (detail is null or length(detail) <= 1000)
);

create index site_reports_site_idx   on public.site_reports (campsite_id, created_at desc);
create index site_reports_reason_idx on public.site_reports (reason, created_at desc);

/*
 * Zone-level alerts. Flags an AREA, never a person.
 *
 * If several independent users report the same kind of problem in the same
 * region within a short window, campers heading there should know.
 */
create table public.zone_alerts (
  id           uuid primary key default gen_random_uuid(),
  centre       geometry(Point, 4326) not null,
  radius_km    double precision not null default 15,
  reason       public.burn_reason not null,
  report_count integer not null default 0,
  severity     smallint not null default 1,
  active_from  timestamptz not null default now(),
  active_until timestamptz not null default (now() + interval '14 days'),
  notes        text,

  constraint zone_alerts_radius_sane   check (radius_km between 1 and 200),
  constraint zone_alerts_severity_range check (severity between 1 and 5)
);

create index zone_alerts_centre_idx on public.zone_alerts using gist (centre);
create index zone_alerts_active_idx on public.zone_alerts (active_until);

create or replace function public.refresh_zone_alerts(
  in_window interval default interval '21 days',
  in_min_reports integer default 3
)
returns integer language plpgsql security definer
set search_path = public, pg_temp
as $$
declare created integer := 0;
begin
  -- Cluster recent reports on a ~0.5 degree grid, then promote clusters that
  -- several DISTINCT users reported and that no live alert already covers.
  with clustered as (
    select
      r.reason,
      st_centroid(st_collect(c.geom)) as centre,
      count(*)                        as report_count,
      count(distinct r.user_id)       as reporter_count
    from public.site_reports r
    join public.campsites c on c.id = r.campsite_id
    where r.created_at > now() - in_window
    group by r.reason, st_snaptogrid(c.geom, 0.5)
  ),
  eligible as (
    select * from clustered where reporter_count >= in_min_reports
  ),
  fresh as (
    select e.* from eligible e
    where not exists (
      select 1 from public.zone_alerts z
      where z.reason = e.reason
        and z.active_until > now()
        and st_dwithin(z.centre::geography, e.centre::geography, z.radius_km * 1000)
    )
  )
  insert into public.zone_alerts (centre, radius_km, reason, report_count, severity, notes)
  select
    f.centre, 15, f.reason, f.report_count,
    least(5, greatest(1, (f.reporter_count / 2)::int)),
    format('Auto-generated from %s reports by %s users', f.report_count, f.reporter_count)
  from fresh f;

  get diagnostics created = row_count;
  return created;
end;
$$;

create or replace function public.zone_alerts_near(
  in_lat double precision, in_lon double precision, in_radius_km double precision default 100
)
returns setof public.zone_alerts
language sql stable
set search_path = public, pg_temp
as $$
  select * from public.zone_alerts z
  where z.active_until > now()
    and st_dwithin(z.centre::geography,
                   st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography,
                   least(in_radius_km, 500) * 1000)
  order by z.severity desc, z.active_from desc
  limit 50;
$$;

-- =====================================================================
--  9. ROAD TELEMETRY
-- =====================================================================

create table public.road_segments (
  id               bigint generated always as identity primary key,
  geom             geometry(LineString, 4326) not null,
  osm_way_id       bigint,
  name             text,

  surface          public.surface_quality,
  roughness_index  double precision,
  sample_count     integer not null default 0,
  min_clearance_cm integer,
  max_height_cm    integer,
  max_weight_kg    integer,

  last_sampled_at  timestamptz,
  updated_at       timestamptz not null default now(),

  constraint road_segments_roughness_range
    check (roughness_index is null or roughness_index between 0 and 100)
);

create index road_segments_geom_idx on public.road_segments using gist (geom);
create index road_segments_osm_idx  on public.road_segments (osm_way_id);

/*
 * Raw accelerometer batches.
 *
 * `dash_mounted` carries the client's orientation check: telemetry recorded
 * while the phone was being handled is noise, not road surface. Rejected
 * batches are stored but excluded from aggregation, so the filter can be
 * retuned later without losing data.
 */
create table public.telemetry_batches (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  rig_id            uuid references public.rigs(id) on delete set null,
  recorded_at       timestamptz not null,
  path              geometry(LineString, 4326) not null,

  sample_hz         smallint not null default 50,
  mean_speed_kph    double precision,
  vertical_variance double precision,
  dash_mounted      boolean not null default false,
  accepted          boolean not null default false,
  reject_reason     text,

  created_at        timestamptz not null default now(),

  constraint telemetry_speed_sane check (mean_speed_kph is null or mean_speed_kph between 0 and 200)
);

create index telemetry_user_idx on public.telemetry_batches (user_id, created_at desc);
create index telemetry_path_idx on public.telemetry_batches using gist (path);

-- Gate: only dash-mounted, moving, plausible batches earn tokens.
create or replace function public.accept_telemetry_batch()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare reward integer; daily integer; cap integer;
begin
  if not new.dash_mounted then
    new.accepted := false;
    new.reject_reason := 'phone not dash-mounted; movement not attributable to road surface';
    return new;
  end if;

  if coalesce(new.mean_speed_kph, 0) < 5 then
    new.accepted := false;
    new.reject_reason := 'stationary or near-stationary';
    return new;
  end if;

  if st_length(new.path::geography) < 200 then
    new.accepted := false;
    new.reject_reason := 'path shorter than 200 m';
    return new;
  end if;

  new.accepted := true;

  select amount, daily_cap into reward, cap
  from public.token_rules where reason = 'telemetry_batch';

  select count(*) into daily
  from public.token_ledger
  where user_id = new.user_id
    and reason = 'telemetry_batch'
    and created_at > now() - interval '24 hours';

  if cap is null or daily < cap then
    perform public.grant_tokens(new.user_id, coalesce(reward, 5), 'telemetry_batch',
                                'telemetry_batches', new.id::text);
  end if;

  return new;
end;
$$;

create trigger telemetry_batches_gate
  before insert on public.telemetry_batches
  for each row execute function public.accept_telemetry_batch();

-- =====================================================================
--  10. HAZARDS & DOT 511
-- =====================================================================

create table public.hazard_reports (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete set null,
  kind       public.hazard_kind not null,
  geom       geometry(Point, 4326) not null,
  detail     text,
  confirms   integer not null default 0,
  disputes   integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),

  constraint hazard_detail_len check (detail is null or length(detail) <= 500)
);

create index hazard_geom_idx   on public.hazard_reports using gist (geom);
create index hazard_active_idx on public.hazard_reports (is_active, expires_at);

create table public.hazard_confirmations (
  hazard_id  uuid not null references public.hazard_reports(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  agrees     boolean not null,
  created_at timestamptz not null default now(),
  primary key (hazard_id, user_id)
);

-- Cached government 511 feeds. Free public data; cache to respect rate limits.
create table public.dot_511_feed (
  id           bigint generated always as identity primary key,
  jurisdiction text not null,
  external_id  text not null,
  event_type   text not null,
  headline     text not null,
  description  text,
  severity     text,
  geom         geometry(Point, 4326),
  road_name    text,
  starts_at    timestamptz,
  ends_at      timestamptz,
  fetched_at   timestamptz not null default now(),
  raw          jsonb,

  constraint dot_511_unique unique (jurisdiction, external_id)
);

create index dot_511_geom_idx  on public.dot_511_feed using gist (geom);
create index dot_511_juris_idx on public.dot_511_feed (jurisdiction, fetched_at desc);

-- Early-reporter bonus: first to flag a hazard others then confirm.
create or replace function public.reward_hazard_confirmation()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare reporter uuid; total integer;
begin
  update public.hazard_reports
     set confirms = confirms + (case when new.agrees then 1 else 0 end),
         disputes = disputes + (case when new.agrees then 0 else 1 end)
   where id = new.hazard_id
  returning user_id, confirms into reporter, total;

  -- Third independent confirmation pays the original reporter.
  if new.agrees and total = 3 and reporter is not null then
    perform public.grant_tokens(
      reporter,
      (select amount from public.token_rules where reason = 'early_hazard_bonus'),
      'early_hazard_bonus', 'hazard_reports', new.hazard_id::text
    );
  end if;

  -- Retire hazards the community disagrees with.
  update public.hazard_reports
     set is_active = false
   where id = new.hazard_id and disputes >= 3 and confirms < disputes;

  return null;
end;
$$;

create trigger hazard_confirmations_reward
  after insert on public.hazard_confirmations
  for each row execute function public.reward_hazard_confirmation();

-- =====================================================================
--  11. POIs & MEDIA
-- =====================================================================

create table public.pois (
  id             uuid primary key default gen_random_uuid(),
  kind           public.poi_kind not null,
  name           text not null,
  geom           geometry(Point, 4326) not null,
  detail         text,

  is_free        boolean,
  price_cents    integer,
  currency       char(3) default 'USD',

  submitted_by   uuid references public.profiles(id) on delete set null,
  status         public.poi_status not null default 'pending',
  upvotes        integer not null default 0,
  downvotes      integer not null default 0,
  check_in_count integer not null default 0,
  consecutive_downvotes integer not null default 0,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint pois_price_sane check (price_cents is null or price_cents between 0 and 100000)
);

create index pois_geom_idx   on public.pois using gist (geom);
create index pois_status_idx on public.pois (status, kind);

create table public.poi_votes (
  poi_id     uuid not null references public.pois(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  is_upvote  boolean not null,
  created_at timestamptz not null default now(),
  primary key (poi_id, user_id)
);

/*
 * Darwinian lifecycle:
 *   pending -> promoted  at +5 net votes
 *   any     -> pruned    at 3 consecutive downvotes (dead/locked/gone)
 */
create or replace function public.poi_lifecycle()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare up integer; down integer; consec integer;
begin
  update public.pois
     set upvotes   = upvotes   + (case when new.is_upvote then 1 else 0 end),
         downvotes = downvotes + (case when new.is_upvote then 0 else 1 end),
         consecutive_downvotes =
           case when new.is_upvote then 0 else consecutive_downvotes + 1 end,
         updated_at = now()
   where id = new.poi_id
  returning upvotes, downvotes, consecutive_downvotes into up, down, consec;

  if consec >= 3 then
    update public.pois set status = 'pruned' where id = new.poi_id;
  elsif (up - down) >= 5 then
    update public.pois set status = 'promoted' where id = new.poi_id;
  end if;

  return null;
end;
$$;

create trigger poi_votes_lifecycle
  after insert on public.poi_votes
  for each row execute function public.poi_lifecycle();

-- Photos, ranked by votes. Drives the media hierarchy in the client:
-- top-voted user photo -> Street View -> aerial satellite.
create table public.campsite_photos (
  id           uuid primary key default gen_random_uuid(),
  campsite_id  text not null references public.campsites(id) on delete cascade,
  user_id      uuid references public.profiles(id) on delete set null,
  storage_path text not null,
  caption      text,
  votes        integer not null default 0,
  is_hidden    boolean not null default false,
  created_at   timestamptz not null default now()
);

create index campsite_photos_site_idx
  on public.campsite_photos (campsite_id, votes desc) where not is_hidden;

create table public.photo_votes (
  photo_id   uuid not null references public.campsite_photos(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (photo_id, user_id)
);

create or replace function public.bump_photo_votes()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  update public.campsite_photos set votes = votes + 1 where id = new.photo_id;
  return null;
end;
$$;

create trigger photo_votes_bump
  after insert on public.photo_votes
  for each row execute function public.bump_photo_votes();

-- =====================================================================
--  12. PRIVATE LAND HOSTING
-- =====================================================================

create table public.host_listings (
  id           uuid primary key default gen_random_uuid(),
  host_id      uuid not null references public.profiles(id) on delete cascade,
  title        text not null,
  description  text,
  geom         geometry(Point, 4326) not null,
  approx_only  boolean not null default true,

  token_price  integer not null default 500,
  max_nights   integer not null default 3,
  max_rig_length_cm integer,
  amenities    jsonb not null default '{}'::jsonb,

  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),

  constraint host_listings_price_sane  check (token_price between 0 and 5000),
  constraint host_listings_nights_sane check (max_nights between 1 and 30)
);

create index host_listings_geom_idx on public.host_listings using gist (geom);

create table public.bookings (
  id           uuid primary key default gen_random_uuid(),
  listing_id   uuid not null references public.host_listings(id) on delete cascade,
  guest_id     uuid not null references public.profiles(id) on delete cascade,
  host_id      uuid not null references public.profiles(id) on delete cascade,
  starts_on    date not null,
  ends_on      date not null,
  token_cost   integer not null,
  status       public.booking_status not null default 'requested',

  guest_reviewed boolean not null default false,
  host_reviewed  boolean not null default false,
  bonus_paid     boolean not null default false,

  created_at   timestamptz not null default now(),

  constraint bookings_dates   check (ends_on > starts_on),
  constraint bookings_no_self check (guest_id <> host_id)
);

create index bookings_guest_idx on public.bookings (guest_id, created_at desc);
create index bookings_host_idx  on public.bookings (host_id, created_at desc);

-- =====================================================================
--  13. CONTEXTUAL RULES ENGINE
-- =====================================================================

create table public.land_regulations (
  id                  bigint generated always as identity primary key,
  land_id             bigint references public.public_lands(id) on delete cascade,
  jurisdiction        text,
  applies_geom        geometry(MultiPolygon, 4326),

  stay_limit_days     integer,
  move_distance_km    integer,
  permit_required     boolean not null default false,
  permit_name         text,
  permit_url          text,
  campfire_policy     text,
  fire_ban_active     boolean not null default false,
  fire_ban_checked_at timestamptz,
  waste_policy        text,
  setback_water_m     integer,
  leave_no_trace      text,
  notes               text,

  effective_from date,
  effective_to   date,

  constraint land_regulations_target check (land_id is not null or applies_geom is not null)
);

create index land_regulations_geom_idx on public.land_regulations using gist (applies_geom);
create index land_regulations_land_idx on public.land_regulations (land_id);

-- Everything the client needs for a geofenced "you just crossed into…" popup.
create or replace function public.rules_at_point(
  in_lat double precision, in_lon double precision
)
returns table (
  land_name text, designation text, confidence public.boundary_confidence,
  attribution text, stay_limit_days integer, permit_required boolean,
  permit_name text, permit_url text, fire_ban_active boolean,
  campfire_policy text, waste_policy text, setback_water_m integer, leave_no_trace text
)
language sql stable
set search_path = public, pg_temp
as $$
  select
    p.name, p.designation, p.confidence, s.attribution,
    coalesce(r.stay_limit_days, p.stay_limit_days),
    coalesce(r.permit_required, p.permit_required),
    coalesce(r.permit_name, p.permit_name),
    r.permit_url,
    coalesce(r.fire_ban_active, false),
    r.campfire_policy, r.waste_policy, r.setback_water_m, r.leave_no_trace
  from public.public_lands p
  join public.land_sources s on s.id = p.source_id
  left join public.land_regulations r
    on r.land_id = p.id
   and (r.effective_from is null or r.effective_from <= current_date)
   and (r.effective_to   is null or r.effective_to   >= current_date)
  where st_intersects(p.geom, st_setsrid(st_makepoint(in_lon, in_lat), 4326))
  order by p.confidence = 'designated_general_use' desc
  limit 5;
$$;

-- =====================================================================
--  14. ROW LEVEL SECURITY
-- =====================================================================

alter table public.profiles             enable row level security;
alter table public.rigs                 enable row level security;
alter table public.friendships          enable row level security;
alter table public.presence             enable row level security;
alter table public.token_ledger         enable row level security;
alter table public.token_rules          enable row level security;
alter table public.reveal_log           enable row level security;
alter table public.scrape_guard         enable row level security;
alter table public.stealth_unlocks      enable row level security;
alter table public.check_ins            enable row level security;
alter table public.site_reports         enable row level security;
alter table public.zone_alerts          enable row level security;
alter table public.road_segments        enable row level security;
alter table public.telemetry_batches    enable row level security;
alter table public.hazard_reports       enable row level security;
alter table public.hazard_confirmations enable row level security;
alter table public.dot_511_feed         enable row level security;
alter table public.pois                 enable row level security;
alter table public.poi_votes            enable row level security;
alter table public.campsite_photos      enable row level security;
alter table public.photo_votes          enable row level security;
alter table public.host_listings        enable row level security;
alter table public.bookings             enable row level security;
alter table public.land_regulations     enable row level security;

create policy "read: profiles" on public.profiles
  for select to anon, authenticated using (true);

create policy "insert: own profile" on public.profiles
  for insert to authenticated with check (id = auth.uid());

create policy "update: own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create or replace function public.protect_trust_columns()
returns trigger language plpgsql as $$
begin
  -- Reset protected columns only for direct client writes. SECURITY DEFINER
  -- functions (recompute_trust) run as the owner, so they pass through.
  if current_user in ('authenticated', 'anon') then
    new.trust_score    := old.trust_score;
    new.trust_tier     := old.trust_tier;
    new.is_suspended   := old.is_suspended;
    new.check_in_count := old.check_in_count;
    new.scout_count    := old.scout_count;
    new.verify_count   := old.verify_count;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_protect_trust
  before update on public.profiles
  for each row execute function public.protect_trust_columns();

create policy "all: own rigs" on public.rigs
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "read: own friendships" on public.friendships
  for select to authenticated using (requester_id = auth.uid() or addressee_id = auth.uid());

create policy "insert: send request" on public.friendships
  for insert to authenticated with check (requester_id = auth.uid());

create policy "update: respond to request" on public.friendships
  for update to authenticated using (addressee_id = auth.uid()) with check (addressee_id = auth.uid());

create policy "delete: own friendships" on public.friendships
  for delete to authenticated using (requester_id = auth.uid() or addressee_id = auth.uid());

-- Precise location is OWNER-ONLY on the base table. Others read via
-- nearby_campers(), which coarsens to a ~1 km grid.
create policy "all: own presence" on public.presence
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Read your own ledger, never write it: minting is service_role +
-- SECURITY DEFINER only.
create policy "read: own ledger" on public.token_ledger
  for select to authenticated using (user_id = auth.uid());

create policy "read: token rules" on public.token_rules
  for select to anon, authenticated using (true);

create policy "read: own reveals" on public.reveal_log
  for select to authenticated using (user_id = auth.uid());

create policy "read: own guard" on public.scrape_guard
  for select to authenticated using (user_id = auth.uid());

create policy "read: own unlocks" on public.stealth_unlocks
  for select to authenticated using (user_id = auth.uid());

create policy "read: public check-ins" on public.check_ins
  for select to anon, authenticated using (not is_private or user_id = auth.uid());

create policy "insert: own check-in" on public.check_ins
  for insert to authenticated with check (user_id = auth.uid());

create policy "update: own check-in" on public.check_ins
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "read: site reports" on public.site_reports
  for select to anon, authenticated using (true);

create policy "insert: own site report" on public.site_reports
  for insert to authenticated with check (user_id = auth.uid());

create policy "read: zone alerts" on public.zone_alerts
  for select to anon, authenticated using (active_until > now());

create policy "read: road segments" on public.road_segments
  for select to anon, authenticated using (true);

create policy "read: own telemetry" on public.telemetry_batches
  for select to authenticated using (user_id = auth.uid());

create policy "insert: own telemetry" on public.telemetry_batches
  for insert to authenticated with check (user_id = auth.uid());

create policy "read: active hazards" on public.hazard_reports
  for select to anon, authenticated using (is_active and expires_at > now());

create policy "insert: own hazard" on public.hazard_reports
  for insert to authenticated with check (user_id = auth.uid());

create policy "read: confirmations" on public.hazard_confirmations
  for select to authenticated using (true);

create policy "insert: own confirmation" on public.hazard_confirmations
  for insert to authenticated with check (user_id = auth.uid());

create policy "read: 511 feed" on public.dot_511_feed
  for select to anon, authenticated using (true);

create policy "read: live POIs" on public.pois
  for select to anon, authenticated using (status <> 'pruned' or submitted_by = auth.uid());

create policy "insert: own POI" on public.pois
  for insert to authenticated with check (submitted_by = auth.uid() and status = 'pending');

create policy "read: POI votes" on public.poi_votes
  for select to authenticated using (true);

create policy "insert: own POI vote" on public.poi_votes
  for insert to authenticated with check (user_id = auth.uid());

create policy "read: visible photos" on public.campsite_photos
  for select to anon, authenticated using (not is_hidden);

create policy "insert: own photo" on public.campsite_photos
  for insert to authenticated with check (user_id = auth.uid());

create policy "delete: own photo" on public.campsite_photos
  for delete to authenticated using (user_id = auth.uid());

create policy "insert: own photo vote" on public.photo_votes
  for insert to authenticated with check (user_id = auth.uid());

create policy "read: photo votes" on public.photo_votes
  for select to authenticated using (true);

create policy "read: active listings" on public.host_listings
  for select to anon, authenticated using (is_active or host_id = auth.uid());

create policy "all: own listings" on public.host_listings
  for all to authenticated using (host_id = auth.uid()) with check (host_id = auth.uid());

create policy "read: own bookings" on public.bookings
  for select to authenticated using (guest_id = auth.uid() or host_id = auth.uid());

create policy "insert: own booking" on public.bookings
  for insert to authenticated with check (guest_id = auth.uid());

create policy "update: party to booking" on public.bookings
  for update to authenticated
  using (guest_id = auth.uid() or host_id = auth.uid())
  with check (guest_id = auth.uid() or host_id = auth.uid());

create policy "read: regulations" on public.land_regulations
  for select to anon, authenticated using (true);

-- =====================================================================
--  15. GRANTS
-- =====================================================================

grant usage on schema public to anon, authenticated;

grant select on
  public.profiles, public.token_rules, public.zone_alerts,
  public.road_segments, public.hazard_reports, public.dot_511_feed,
  public.pois, public.campsite_photos, public.site_reports,
  public.check_ins, public.host_listings, public.land_regulations
  to anon, authenticated;

grant select, insert, update, delete on public.rigs, public.friendships, public.presence
  to authenticated;

grant select on
  public.token_ledger, public.reveal_log, public.scrape_guard,
  public.stealth_unlocks, public.poi_votes, public.photo_votes,
  public.hazard_confirmations, public.telemetry_batches, public.bookings
  to authenticated;

grant insert on
  public.check_ins, public.site_reports, public.telemetry_batches,
  public.hazard_reports, public.hazard_confirmations, public.pois,
  public.poi_votes, public.campsite_photos, public.photo_votes,
  public.bookings, public.profiles
  to authenticated;

grant update on public.check_ins, public.bookings, public.profiles to authenticated;
grant delete on public.campsite_photos to authenticated;
grant all on public.host_listings to authenticated;

grant execute on function
  public.nearby_campers(double precision, double precision, double precision),
  public.campsites_visible(double precision, double precision, double precision),
  public.unlock_stealth_site(text),
  public.zone_alerts_near(double precision, double precision, double precision),
  public.rules_at_point(double precision, double precision),
  public.token_balance(uuid),
  public.are_friends(uuid, uuid),
  public.tier_rank(public.trust_tier)
  to authenticated;

grant execute on function
  public.rules_at_point(double precision, double precision),
  public.zone_alerts_near(double precision, double precision, double precision)
  to anon;

-- Economy and moderation internals stay server-side.
revoke execute on function
  public.grant_tokens(uuid, integer, public.token_reason, text, text, text),
  public.spend_tokens(uuid, integer, public.token_reason, text, text),
  public.recompute_trust(uuid),
  public.refresh_zone_alerts(interval, integer),
  public.purge_expired_presence(),
  public.check_reveal_quota(uuid)
  from anon, authenticated;

commit;

-- =====================================================================
--  POST-INSTALL
--
--  1. refresh materialized view concurrently public.token_balances;
--
--  2. Optional pg_cron jobs:
--       select cron.schedule('purge-presence', '*/15 * * * *',
--         $$select public.purge_expired_presence()$$);
--       select cron.schedule('zone-alerts', '0 * * * *',
--         $$select public.refresh_zone_alerts()$$);
--
--  3. Auto-create a profile on signup — see AUTH_SETUP.md
-- =====================================================================
