-- =====================================================================
--  Wandrlust — Migration 04: Real reviews, alerts, POI amenities, settings
--
--  Run AFTER migration 03. Additive.
--
--  WHAT THIS FIXES
--
--  1. Host/guest ratings were fake. `bookings.guest_reviewed` and
--     `host_reviewed` were BOOLEANS that fired the 10% token bonus, with
--     nowhere to store the rating or the text. The bonus paid out on a
--     checkbox. This adds a real `booking_reviews` table.
--
--  2. Host listings had no amenity structure — just a jsonb blob.
--
--  3. Weather/fire/flood/storm alerts had nowhere to live. Added
--     `weather_alerts` cache plus `fire_bans` for agency-issued
--     restrictions that are NOT in any weather feed.
--
--  4. No user settings table.
-- =====================================================================

begin;

drop type if exists public.review_direction cascade;
drop type if exists public.hazard_family    cascade;
drop type if exists public.alert_severity   cascade;
drop type if exists public.fire_ban_stage   cascade;

create type public.review_direction as enum ('guest_to_host', 'host_to_guest');

create type public.hazard_family as enum
  ('fire', 'flood', 'storm', 'winter', 'heat', 'wind', 'other');

create type public.alert_severity as enum
  ('extreme', 'severe', 'moderate', 'minor', 'unknown');

/*
 * Fire restriction stages. These come from land agencies, NOT weather
 * services — a Red Flag Warning is a forecast, a Stage 2 ban is a legal
 * restriction. Conflating them is how people end up with an illegal campfire.
 */
create type public.fire_ban_stage as enum (
  'none',
  'stage_1',      -- no open fires; contained/liquid-fuel stoves usually OK
  'stage_2',      -- no fires at all, often no generators or smoking outdoors
  'stage_3',      -- area closure
  'total_ban'
);

-- ---------------------------------------------------------------------
-- Booking reviews — the real thing
-- ---------------------------------------------------------------------
create table public.booking_reviews (
  id         uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  author_id  uuid not null references public.profiles(id) on delete cascade,
  subject_id uuid not null references public.profiles(id) on delete cascade,
  direction  public.review_direction not null,

  rating     smallint not null,
  comment    text not null,

  -- Sub-ratings. Guest-to-host only; null for the reverse direction.
  accuracy_rating    smallint,
  cleanliness_rating smallint,
  access_rating      smallint,

  -- Withheld until BOTH sides submit (or the window closes), so neither
  -- party can read the other's review before writing their own.
  is_visible boolean not null default false,

  created_at timestamptz not null default now(),

  constraint booking_reviews_one_per_side unique (booking_id, direction),
  constraint booking_reviews_rating_range check (rating between 1 and 5),
  constraint booking_reviews_sub_ranges check (
    (accuracy_rating    is null or accuracy_rating    between 1 and 5) and
    (cleanliness_rating is null or cleanliness_rating between 1 and 5) and
    (access_rating      is null or access_rating      between 1 and 5)
  ),
  constraint booking_reviews_comment_len check (length(btrim(comment)) between 1 and 2000),
  constraint booking_reviews_no_self check (author_id <> subject_id)
);

create index booking_reviews_subject_idx on public.booking_reviews (subject_id, created_at desc);
create index booking_reviews_booking_idx on public.booking_reviews (booking_id);

comment on table public.booking_reviews is
  'Double-blind: reviews stay hidden until both parties submit, so nobody can retaliate against a review they have already read.';

alter table public.profiles
  add column if not exists host_rating        numeric(2,1) not null default 0,
  add column if not exists host_review_count  integer      not null default 0,
  add column if not exists guest_rating       numeric(2,1) not null default 0,
  add column if not exists guest_review_count integer      not null default 0;

/*
 * When both sides have reviewed, reveal both and pay the mutual bonus.
 * Replaces the boolean-driven trigger from migration 02, which paid out
 * without any review content existing.
 */
create or replace function public.finalise_booking_reviews()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  b public.bookings%rowtype;
  both_present boolean;
  bonus integer;
begin
  select * into b from public.bookings where id = new.booking_id;
  if not found then return null; end if;

  select count(*) = 2 into both_present
  from public.booking_reviews where booking_id = new.booking_id;

  if both_present then
    update public.booking_reviews set is_visible = true where booking_id = new.booking_id;

    -- Mirror the flags so existing queries keep working.
    update public.bookings set guest_reviewed = true, host_reviewed = true
     where id = new.booking_id;

    if not b.bonus_paid then
      bonus := greatest(1, (b.token_cost * 0.10)::int);
      perform public.grant_tokens(b.guest_id, bonus, 'mutual_review_bonus', 'bookings', b.id::text);
      perform public.grant_tokens(b.host_id,  bonus, 'mutual_review_bonus', 'bookings', b.id::text);
      update public.bookings set bonus_paid = true where id = b.id;
    end if;
  else
    -- Record which side has filed so the UI can prompt the other.
    if new.direction = 'guest_to_host' then
      update public.bookings set guest_reviewed = true where id = new.booking_id;
    else
      update public.bookings set host_reviewed = true where id = new.booking_id;
    end if;
  end if;

  -- Refresh the subject's aggregate rating from visible reviews only.
  update public.profiles p
     set host_rating = coalesce((
           select round(avg(r.rating)::numeric, 1) from public.booking_reviews r
            where r.subject_id = p.id and r.direction = 'guest_to_host' and r.is_visible
         ), 0),
         host_review_count = (
           select count(*) from public.booking_reviews r
            where r.subject_id = p.id and r.direction = 'guest_to_host' and r.is_visible
         ),
         guest_rating = coalesce((
           select round(avg(r.rating)::numeric, 1) from public.booking_reviews r
            where r.subject_id = p.id and r.direction = 'host_to_guest' and r.is_visible
         ), 0),
         guest_review_count = (
           select count(*) from public.booking_reviews r
            where r.subject_id = p.id and r.direction = 'host_to_guest' and r.is_visible
         )
   where p.id = new.subject_id;

  return null;
end;
$$;

create trigger booking_reviews_finalise
  after insert on public.booking_reviews
  for each row execute function public.finalise_booking_reviews();

-- The old boolean-driven bonus trigger is now wrong: drop it so the bonus
-- cannot fire twice or fire without review content.
drop trigger if exists bookings_mutual_bonus on public.bookings;

-- Reviews become visible after 14 days even if one side never replies, so a
-- silent party cannot suppress honest feedback forever.
create or replace function public.release_stale_reviews()
returns integer language plpgsql security definer
set search_path = public, pg_temp
as $$
declare n integer;
begin
  update public.booking_reviews set is_visible = true
   where not is_visible and created_at < now() - interval '14 days';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------
-- Host listing amenities
-- ---------------------------------------------------------------------
alter table public.host_listings
  add column if not exists has_water         boolean not null default false,
  add column if not exists has_toilet        boolean not null default false,
  add column if not exists has_shower        boolean not null default false,
  add column if not exists has_power         boolean not null default false,
  add column if not exists has_dump_station  boolean not null default false,
  add column if not exists has_wifi          boolean not null default false,
  add column if not exists allows_fires      boolean not null default false,
  add column if not exists allows_pets       boolean not null default true,
  add column if not exists allows_generators boolean not null default true,
  add column if not exists is_pull_through   boolean not null default false,
  add column if not exists surface_type      text,
  add column if not exists max_rigs          integer not null default 1,
  add column if not exists quiet_hours       text,
  add column if not exists arrival_notes     text,
  add column if not exists photos            text[] not null default '{}';

create index if not exists host_listings_amenity_idx
  on public.host_listings (has_water, has_toilet, has_power) where is_active;

-- ---------------------------------------------------------------------
-- Weather / fire / flood / storm alerts
-- ---------------------------------------------------------------------
create table public.weather_alerts (
  id               text primary key,
  family           public.hazard_family not null,
  event            text not null,
  headline         text not null,
  description      text,
  instruction      text,
  severity         public.alert_severity not null default 'unknown',
  urgency          text,
  area_description text,
  sender           text,
  geom             geometry(MultiPolygon, 4326),
  effective        timestamptz,
  expires          timestamptz,
  source           text not null,
  fetched_at       timestamptz not null default now()
);

create index weather_alerts_geom_idx   on public.weather_alerts using gist (geom);
create index weather_alerts_expiry_idx on public.weather_alerts (expires);
create index weather_alerts_family_idx on public.weather_alerts (family, severity);

comment on table public.weather_alerts is
  'Cache of NWS / ECCC alerts. Authoritative source is always the issuing agency.';

/*
 * Agency fire restrictions.
 *
 * Deliberately separate from weather_alerts. A Red Flag Warning is a weather
 * forecast; a Stage 2 restriction is a legal prohibition issued by the land
 * manager. Campers need the second one, and no weather API carries it.
 */
create table public.fire_bans (
  id             bigint generated always as identity primary key,
  jurisdiction   text not null,
  authority      text not null,
  area_name      text not null,
  stage          public.fire_ban_stage not null default 'none',
  geom           geometry(MultiPolygon, 4326),
  land_id        bigint references public.public_lands(id) on delete cascade,

  details        text,
  source_url     text,
  effective_from date,
  effective_to   date,
  verified_at    timestamptz not null default now(),
  verified_by    uuid references public.profiles(id) on delete set null,

  constraint fire_bans_target check (geom is not null or land_id is not null)
);

create index fire_bans_geom_idx  on public.fire_bans using gist (geom);
create index fire_bans_stage_idx on public.fire_bans (stage) where stage <> 'none';

/** Everything hazard-related at a point, in one call. */
create or replace function public.hazards_at_point(
  in_lat double precision, in_lon double precision
)
returns table (
  kind text, family public.hazard_family, title text, detail text,
  severity public.alert_severity, stage public.fire_ban_stage,
  authority text, source_url text, expires timestamptz
)
language sql stable
set search_path = public, pg_temp
as $$
  with pt as (select st_setsrid(st_makepoint(in_lon, in_lat), 4326) as g)
  select
    'weather_alert'::text, w.family, w.headline, w.description,
    w.severity, null::public.fire_ban_stage, w.sender, null::text, w.expires
  from public.weather_alerts w, pt
  where (w.geom is null or st_intersects(w.geom, pt.g))
    and (w.expires is null or w.expires > now())

  union all

  select
    'fire_ban'::text, 'fire'::public.hazard_family, f.area_name, f.details,
    case f.stage
      when 'total_ban' then 'extreme' when 'stage_3' then 'extreme'
      when 'stage_2' then 'severe' when 'stage_1' then 'moderate'
      else 'minor'
    end::public.alert_severity,
    f.stage, f.authority, f.source_url,
    (f.effective_to + interval '1 day')::timestamptz
  from public.fire_bans f
  left join public.public_lands p on p.id = f.land_id, pt
  where f.stage <> 'none'
    and (f.effective_to is null or f.effective_to >= current_date)
    and (
      (f.geom is not null and st_intersects(f.geom, pt.g))
      or (p.geom is not null and st_intersects(p.geom, pt.g))
    );
$$;

create or replace function public.purge_expired_alerts()
returns integer language plpgsql security definer
set search_path = public, pg_temp
as $$
declare n integer;
begin
  delete from public.weather_alerts
   where expires is not null and expires < now() - interval '1 day';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------
-- User settings & notification preferences
-- ---------------------------------------------------------------------
create table public.user_settings (
  user_id                uuid primary key references public.profiles(id) on delete cascade,

  notify_fire_alerts     boolean not null default true,
  notify_flood_alerts    boolean not null default true,
  notify_storm_alerts    boolean not null default true,
  notify_zone_heat       boolean not null default true,
  notify_hazards_nearby  boolean not null default true,
  notify_booking_updates boolean not null default true,
  alert_radius_km        integer not null default 80,

  share_presence         boolean not null default false,
  share_telemetry        boolean not null default false,

  use_metric             boolean not null default true,
  map_style              text    not null default 'satellite',

  -- Support link. Firewalled to settings: no purchase prompts anywhere else,
  -- and it is not a token purchase path.
  show_support_link      boolean not null default true,

  push_token             text,
  updated_at             timestamptz not null default now(),

  constraint user_settings_radius_sane check (alert_radius_km between 10 and 500)
);

create or replace function public.touch_settings()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;

create trigger user_settings_touch
  before update on public.user_settings
  for each row execute function public.touch_settings();

-- ---------------------------------------------------------------------
-- Saved campsites (server-side mirror of the local bookmark list)
-- ---------------------------------------------------------------------
create table public.saved_campsites (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  campsite_id text not null references public.campsites(id) on delete cascade,
  notes       text,
  saved_at    timestamptz not null default now(),
  primary key (user_id, campsite_id)
);

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.booking_reviews enable row level security;
alter table public.weather_alerts  enable row level security;
alter table public.fire_bans       enable row level security;
alter table public.user_settings   enable row level security;
alter table public.saved_campsites enable row level security;

create policy "read: visible reviews" on public.booking_reviews
  for select to anon, authenticated
  using (is_visible or author_id = auth.uid() or subject_id = auth.uid());

-- You may only review a booking you were part of, in your own direction, and
-- only once it is completed.
create policy "insert: own booking review" on public.booking_reviews
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.bookings b
      where b.id = booking_id
        and b.status = 'completed'
        and (
          (direction = 'guest_to_host' and b.guest_id = auth.uid() and b.host_id = subject_id)
          or
          (direction = 'host_to_guest' and b.host_id  = auth.uid() and b.guest_id = subject_id)
        )
    )
  );

create policy "read: weather alerts" on public.weather_alerts
  for select to anon, authenticated using (true);

create policy "read: fire bans" on public.fire_bans
  for select to anon, authenticated using (true);

create policy "all: own settings" on public.user_settings
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "all: own saved" on public.saved_campsites
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select on public.booking_reviews, public.weather_alerts, public.fire_bans
  to anon, authenticated;
grant insert on public.booking_reviews to authenticated;
grant select, insert, update, delete on public.user_settings, public.saved_campsites
  to authenticated;

grant execute on function public.hazards_at_point(double precision, double precision)
  to anon, authenticated;

revoke execute on function
  public.release_stale_reviews(), public.purge_expired_alerts()
  from anon, authenticated;

commit;

-- =====================================================================
--  POST-INSTALL
--    select cron.schedule('purge-alerts', '0 * * * *',
--      $$select public.purge_expired_alerts()$$);
--    select cron.schedule('release-reviews', '0 3 * * *',
--      $$select public.release_stale_reviews()$$);
--    select * from public.hazards_at_point(51.0447, -114.0719);
-- =====================================================================