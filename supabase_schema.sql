-- =====================================================================
--  Wandrlust — Migration 01: Core schema
--
--  Run in: Supabase Dashboard → SQL Editor → New query
--
--  DESTRUCTIVE. Drops and recreates everything.
--
--  Changes from a naive schema, and why:
--
--  1. No `data jsonb` catch-all. Every Campsite field is a real column,
--     so you can filter server-side instead of pulling whole rows.
--
--  2. No `is_crown_land boolean`. That column is what broke the app: a
--     script wrote `false` to all rows, and the map skipped any site
--     where it was false, so nothing rendered. A nullable boolean
--     conflated "verified not crown land" with "never checked".
--     Replaced by `land_verification` — an explicit 3-state enum.
--
--  3. RLS is NOT `ALL` for `anon`. The anon key ships in your client
--     bundle, so anyone who opened devtools could `DELETE FROM
--     campsites`. Writes require the service_role key.
-- =====================================================================

begin;

create extension if not exists postgis;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------
-- 1. Teardown
-- ---------------------------------------------------------------------
drop table if exists public.campsite_reviews cascade;
drop table if exists public.campsites cascade;
drop table if exists public.public_lands cascade;
drop table if exists public.land_sources cascade;

drop type if exists public.land_type cascade;
drop type if exists public.road_access cascade;
drop type if exists public.toilet_type cascade;
drop type if exists public.water_type cascade;
drop type if exists public.shade_type cascade;
drop type if exists public.campsite_source cascade;
drop type if exists public.land_verification cascade;
drop type if exists public.boundary_confidence cascade;

-- ---------------------------------------------------------------------
-- 2. Enums — these mirror src/types.ts exactly, so a typo in a seed
--    script fails loudly instead of silently poisoning the dataset.
-- ---------------------------------------------------------------------
create type public.land_type as enum
  ('blm', 'usfs', 'state_forest', 'dispersed', 'crown_land');

create type public.road_access as enum
  ('paved', 'gravel', 'high_clearance', '4x4_only');

create type public.toilet_type as enum
  ('none', 'vault', 'flush', 'pack_out');

create type public.water_type as enum
  ('none', 'potable', 'natural_stream', 'seasonal_creek');

create type public.shade_type as enum ('full', 'partial', 'none');

create type public.campsite_source as enum
  ('verified', 'overpass', 'user_submitted', 'gemini_discovered');

-- Replaces the old is_crown_land boolean.
create type public.land_verification as enum (
  'unverified',   -- never checked against a boundary dataset
  'verified',     -- confirmed inside campable public land
  'outside'       -- checked, and it is NOT on campable public land
);

-- Mirrors BoundaryConfidence in src/services/boundaryService.ts.
create type public.boundary_confidence as enum (
  'designated_general_use',  -- source explicitly designates General Use
  'managing_agency',         -- we know the agency, not the permitted activity
  'managed_zone'             -- named management zone with local rules
);

-- ---------------------------------------------------------------------
-- 3. land_sources — provenance registry
-- ---------------------------------------------------------------------
create table public.land_sources (
  id            text primary key,
  label         text not null,
  attribution   text not null,
  service_url   text not null,
  confidence    public.boundary_confidence not null,
  jurisdiction  text not null,
  licence       text,
  last_synced   timestamptz,
  notes         text
);

comment on table public.land_sources is
  'Registry of authoritative boundary datasets. One row per upstream service.';

-- ---------------------------------------------------------------------
-- 4. public_lands — cached boundary polygons.
--
--    Only land that is general use and OK to camp on. `camping_allowed`
--    is CHECK-constrained to true, so a row that fails that test cannot
--    physically be inserted.
--
--    `general_use_basis` is required and free-text: it records WHY you
--    concluded this parcel is campable. That matters because only
--    Ontario ships an explicit designation — for BLM/USFS you are making
--    a policy call, and that call should be written down.
-- ---------------------------------------------------------------------
create table public.public_lands (
  id                 bigint generated always as identity primary key,
  source_id          text not null references public.land_sources(id) on delete cascade,

  -- Stable upstream identifier, so re-syncing updates rather than duplicates.
  external_id        text not null,

  name               text not null,
  designation        text not null,
  confidence         public.boundary_confidence not null,

  jurisdiction       text not null,
  admin_area         text,

  camping_allowed    boolean not null default true,
  general_use_basis  text    not null,
  stay_limit_days    integer,
  permit_required    boolean not null default false,
  permit_name        text,
  restrictions       text,

  geom               geometry(MultiPolygon, 4326) not null,
  area_sq_km         double precision,

  effective_date     date,
  synced_at          timestamptz not null default now(),

  constraint public_lands_unique_feature unique (source_id, external_id),

  -- The hard guarantee: this table only ever holds campable land.
  constraint public_lands_campable_only check (camping_allowed is true),
  constraint public_lands_basis_not_blank check (length(btrim(general_use_basis)) > 0),
  constraint public_lands_stay_limit_sane
    check (stay_limit_days is null or stay_limit_days between 1 and 365)
);

comment on table public.public_lands is
  'Cached general-use public land polygons. Seed once; these rarely change.';
comment on column public.public_lands.general_use_basis is
  'Why this parcel is considered campable. Required — forces the reasoning to be recorded, especially for sources with no explicit general-use designation.';

create index public_lands_geom_idx   on public.public_lands using gist (geom);
create index public_lands_source_idx on public.public_lands (source_id);
create index public_lands_juris_idx  on public.public_lands (jurisdiction);

-- ---------------------------------------------------------------------
-- 5. campsites — flattened to match the Campsite interface
-- ---------------------------------------------------------------------
create table public.campsites (
  id                  text primary key,
  name                text not null,

  land_type           public.land_type not null,
  land_manager        text not null default '',

  latitude            double precision not null,
  longitude           double precision not null,
  -- Generated from lat/lon so it can never drift out of sync.
  geom                geometry(Point, 4326)
                      generated always as
                        (st_setsrid(st_makepoint(longitude, latitude), 4326)) stored,
  elevation_ft        integer,

  nearest_city        text not null default '',
  state_province      text not null default '',
  country             text not null default '',
  address_description text,

  description         text not null default '',

  water               public.water_type  not null default 'none',
  toilet              public.toilet_type not null default 'none',
  road_access         public.road_access not null default 'gravel',
  cell_verizon        smallint not null default 0,
  cell_att            smallint not null default 0,
  cell_tmobile        smallint not null default 0,
  max_rv_length_feet  integer  not null default 0,
  fire_ring           boolean  not null default false,
  pet_friendly        boolean  not null default true,
  trash_service       boolean  not null default false,
  shade               public.shade_type not null default 'partial',
  stay_limit_days     integer  not null default 14,
  is_free             boolean  not null default true,
  permit_required     boolean  not null default false,

  images              text[]   not null default '{}',

  rating              numeric(2,1) not null default 0,
  review_count        integer      not null default 0,

  source              public.campsite_source not null default 'verified',

  -- Boundary verification. Replaces is_crown_land.
  land_verification   public.land_verification not null default 'unverified',
  verified_land_id    bigint references public.public_lands(id) on delete set null,
  verified_at         timestamptz,

  -- Moderation gate for anonymous submissions.
  is_published        boolean not null default true,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint campsites_lat_range   check (latitude  between -90  and 90),
  constraint campsites_lon_range   check (longitude between -180 and 180),
  constraint campsites_rating_range check (rating between 0 and 5),
  constraint campsites_cell_range check (
    cell_verizon between 0 and 5 and
    cell_att     between 0 and 5 and
    cell_tmobile between 0 and 5
  ),
  constraint campsites_stay_limit_sane check (stay_limit_days between 1 and 365),
  -- If it's marked verified, it must say against what.
  constraint campsites_verified_needs_ref check (
    land_verification <> 'verified' or verified_land_id is not null
  )
);

comment on column public.campsites.land_verification is
  'Three-state, replacing the old is_crown_land boolean which could not distinguish "checked and false" from "never checked".';

create index campsites_geom_idx         on public.campsites using gist (geom);
create index campsites_land_type_idx    on public.campsites (land_type);
create index campsites_published_idx    on public.campsites (is_published) where is_published;
create index campsites_verification_idx on public.campsites (land_verification);
create index campsites_name_trgm_idx    on public.campsites using gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------
-- 6. campsite_reviews — 1:N, was nested inside the jsonb blob.
--    Splitting it out lets the app append a review without rewriting the
--    parent row (and racing another user's write).
-- ---------------------------------------------------------------------
create table public.campsite_reviews (
  id           uuid primary key default gen_random_uuid(),
  campsite_id  text not null references public.campsites(id) on delete cascade,
  author       text not null,
  rating       smallint not null,
  comment      text not null,
  vehicle_type text,
  visited_on   date,
  created_at   timestamptz not null default now(),

  constraint campsite_reviews_rating_range check (rating between 1 and 5),
  constraint campsite_reviews_author_len  check (length(btrim(author))  between 1 and 60),
  constraint campsite_reviews_comment_len check (length(btrim(comment)) between 1 and 2000)
);

create index campsite_reviews_site_idx on public.campsite_reviews (campsite_id, created_at desc);

-- ---------------------------------------------------------------------
-- 7. Triggers
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger campsites_touch_updated_at
  before update on public.campsites
  for each row execute function public.touch_updated_at();

create or replace function public.refresh_campsite_rating()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target text := coalesce(new.campsite_id, old.campsite_id);
begin
  update public.campsites c
     set rating = coalesce((
           select round(avg(r.rating)::numeric, 1)
             from public.campsite_reviews r where r.campsite_id = target
         ), 0),
         review_count = (
           select count(*) from public.campsite_reviews r where r.campsite_id = target
         )
   where c.id = target;
  return null;
end;
$$;

create trigger campsite_reviews_refresh_rating
  after insert or update or delete on public.campsite_reviews
  for each row execute function public.refresh_campsite_rating();

-- ---------------------------------------------------------------------
-- 8. RPCs
-- ---------------------------------------------------------------------

-- Radius search, ordered by true geodesic distance. Replaces pulling every
-- row and running Haversine in the browser.
create or replace function public.campsites_near(
  in_lat          double precision,
  in_lon          double precision,
  in_radius_miles double precision default 100,
  in_land_types   public.land_type[] default null,
  in_limit        integer default 200
)
returns table (
  id text, name text, land_type public.land_type, land_manager text,
  latitude double precision, longitude double precision, description text,
  rating numeric, review_count integer, stay_limit_days integer,
  land_verification public.land_verification, distance_miles double precision
)
language sql stable
set search_path = public, pg_temp
as $$
  select
    c.id, c.name, c.land_type, c.land_manager,
    c.latitude, c.longitude, c.description,
    c.rating, c.review_count, c.stay_limit_days, c.land_verification,
    st_distance(
      c.geom::geography,
      st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography
    ) / 1609.344 as distance_miles
  from public.campsites c
  where c.is_published
    and (in_land_types is null or c.land_type = any(in_land_types))
    and st_dwithin(
          c.geom::geography,
          st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography,
          in_radius_miles * 1609.344
        )
  order by distance_miles
  limit greatest(1, least(in_limit, 500));
$$;

-- Point-in-polygon test against cached campable land. Because public_lands
-- only holds camping-approved parcels, a hit means "inside land we have
-- recorded as general use".
create or replace function public.is_campable_land(
  in_lat double precision, in_lon double precision
)
returns table (
  land_id bigint, name text, designation text,
  confidence public.boundary_confidence, source_id text,
  stay_limit_days integer, permit_required boolean, permit_name text
)
language sql stable
set search_path = public, pg_temp
as $$
  select p.id, p.name, p.designation, p.confidence, p.source_id,
         p.stay_limit_days, p.permit_required, p.permit_name
  from public.public_lands p
  where st_intersects(p.geom, st_setsrid(st_makepoint(in_lon, in_lat), 4326))
  order by p.confidence = 'designated_general_use' desc
  limit 5;
$$;

-- Boundary polygons for a viewport as GeoJSON, so the map can read cached
-- geometry from Postgres instead of hitting upstream ArcGIS services.
create or replace function public.boundaries_in_bbox(
  min_lat double precision, min_lon double precision,
  max_lat double precision, max_lon double precision,
  in_limit integer default 300
)
returns table (
  id bigint, name text, designation text,
  confidence public.boundary_confidence, source_id text, geojson jsonb
)
language sql stable
set search_path = public, pg_temp
as $$
  select p.id, p.name, p.designation, p.confidence, p.source_id,
         st_asgeojson(
           st_simplifypreservetopology(
             p.geom,
             greatest(abs(max_lon - min_lon), abs(max_lat - min_lat)) / 800
           )
         )::jsonb
  from public.public_lands p
  where p.geom && st_makeenvelope(min_lon, min_lat, max_lon, max_lat, 4326)
  limit greatest(1, least(in_limit, 1000));
$$;

-- Backfill campsite verification from cached polygons. Run once after
-- seeding public_lands. This replaces the old per-site Mapbox tilequery.
create or replace function public.reverify_campsites()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare touched integer;
begin
  update public.campsites c
     set land_verification = 'verified',
         verified_land_id  = m.land_id,
         verified_at       = now()
    from lateral (
      select p.id as land_id
        from public.public_lands p
       where st_intersects(p.geom, c.geom)
       order by p.confidence = 'designated_general_use' desc
       limit 1
    ) m
   where true;

  get diagnostics touched = row_count;

  update public.campsites c
     set land_verification = 'outside', verified_land_id = null, verified_at = now()
   where not exists (
     select 1 from public.public_lands p where st_intersects(p.geom, c.geom)
   );

  return touched;
end;
$$;

comment on function public.reverify_campsites is
  'Recomputes land_verification for every campsite from cached polygons. Safe to re-run.';

-- ---------------------------------------------------------------------
-- 9. Row Level Security
--
--    The anon key is public — it is compiled into your client bundle.
--    Treat it as untrusted. Writes belong to service_role.
-- ---------------------------------------------------------------------
alter table public.campsites        enable row level security;
alter table public.campsite_reviews enable row level security;
alter table public.public_lands     enable row level security;
alter table public.land_sources     enable row level security;

create policy "public read: land sources"
  on public.land_sources for select to anon, authenticated using (true);

create policy "public read: land boundaries"
  on public.public_lands for select to anon, authenticated using (true);

create policy "public read: published campsites"
  on public.campsites for select to anon, authenticated using (is_published);

-- Anonymous submissions land in a moderation queue and cannot forge
-- provenance or verification status.
create policy "public insert: user submissions only"
  on public.campsites for insert to anon, authenticated
  with check (
    source = 'user_submitted'
    and is_published = false
    and land_verification = 'unverified'
    and verified_land_id is null
    and rating = 0
    and review_count = 0
  );

create policy "public read: reviews"
  on public.campsite_reviews for select to anon, authenticated using (true);

create policy "public insert: reviews"
  on public.campsite_reviews for insert to anon, authenticated
  with check (
    rating between 1 and 5
    and length(btrim(comment)) between 1 and 2000
    and exists (
      select 1 from public.campsites c where c.id = campsite_id and c.is_published
    )
  );

-- No UPDATE or DELETE policy exists for anon on any table, so those are
-- denied by default. service_role bypasses RLS entirely for seeding.

-- ---------------------------------------------------------------------
-- 10. Grants
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select on public.campsites, public.campsite_reviews,
                public.public_lands, public.land_sources
  to anon, authenticated;

grant insert on public.campsites, public.campsite_reviews to anon, authenticated;

grant execute on function
  public.campsites_near(double precision, double precision, double precision, public.land_type[], integer),
  public.is_campable_land(double precision, double precision),
  public.boundaries_in_bbox(double precision, double precision, double precision, double precision, integer)
  to anon, authenticated;

revoke execute on function public.reverify_campsites() from anon, authenticated;

commit;

-- =====================================================================
--  POST-INSTALL
--
--    npm run seed
--    select public.reverify_campsites();
--    select land_verification, count(*) from public.campsites group by 1;
-- =====================================================================