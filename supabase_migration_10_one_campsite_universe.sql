-- =====================================================================
--  Wandrlust migration 10 — one campsite universe
--
--  WHY THIS EXISTS
--
--  The app has been running two parallel campsite worlds that never touched.
--
--    A. What the UI renders: 21 curated sites bundled into the JS, live
--       OpenStreetMap results, and user submissions saved to the browser's
--       own storage. All client-side.
--    B. What this database models: public.campsites, campsites_visible(),
--       campsite_reviews, check_ins, site_reports, saved_campsites — fully
--       specified, RLS'd, and read by nothing.
--
--  The consequences were not subtle. A camper who submitted a spot was
--  writing a private bookmark nobody else would ever see. A review did not
--  survive a page reload. And because check_ins.campsite_id and
--  site_reports.campsite_id are `references public.campsites(id)`, checking
--  in to any OpenStreetMap or user-added site violated a foreign key and put
--  a raw Postgres error in front of the user.
--
--  WHAT THIS MIGRATION DECIDES
--
--  The client-side id stays the primary key, and an OSM site is materialised
--  into public.campsites the first time somebody interacts with it
--  (ensure_campsite below). The alternative — making campsite_id nullable
--  across the six tables that reference it — needs six schema changes and
--  leaves refresh_campsite_rating with no parent row to write an average
--  into, so campsites.rating would only ever be right for a subset. Lazy
--  materialisation is one function, no child-table changes, and it turns an
--  OSM node somebody checked into a first-class shared record.
--
--  ON HIDING RATHER THAN DELETING
--
--  There has never been any way to flag, hide or remove bad content
--  anywhere in this app. A community app that cannot remove bad data is a
--  liability, especially one whose stated rule is never to overstate what it
--  knows. What this adds is a curtain, not an eraser: is_hidden columns and
--  an auto-hide at three distinct reporters. Nothing here ever deletes a
--  row, so a wrong call costs nothing and is reversible with the service
--  role key.
--
--  Run AFTER 09.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Provenance, so a site can be traced back to where it came from
-- ---------------------------------------------------------------------
-- external_ref is what makes materialising the same OSM node twice a no-op,
-- and what a future bulk importer would key on. It is deliberately NOT a
-- replacement for the id: the id stays the thing every child table points at.
alter table public.campsites
  add column if not exists external_source text,
  add column if not exists external_ref    text,
  add column if not exists is_hidden       boolean not null default false;

create unique index if not exists campsites_external_ref_idx
  on public.campsites (external_source, external_ref)
  where external_ref is not null;

create index if not exists campsites_submitted_by_idx
  on public.campsites (submitted_by)
  where submitted_by is not null;

-- ---------------------------------------------------------------------
-- 2. Materialise an OpenStreetMap site on first interaction
-- ---------------------------------------------------------------------
/*
 * Called before a check-in, review or site report against an `osm-…` id.
 *
 * DELIBERATELY NARROW. It will only ever create a row whose id matches the
 * OSM id format. It cannot be used to forge a curated site, to publish a
 * user submission without review, or to write any amenity value — a
 * materialised OSM record carries a name, a land type and a position, and
 * everything else stays at the column default until somebody records it.
 *
 * Rate-limited through the same scrape_guard that gates coordinate reveals,
 * so it cannot be driven as a bulk-write endpoint.
 */
create or replace function public.ensure_campsite(
  in_id           text,
  in_name         text,
  in_land_type    public.land_type,
  in_lat          double precision,
  in_lon          double precision,
  in_land_manager text default '',
  in_description  text default ''
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'authentication required';
  end if;

  if in_id !~ '^osm-(node|way|relation)-[0-9]+$' then
    raise exception 'ensure_campsite only materialises OpenStreetMap sites, got %', in_id;
  end if;

  if in_lat is null or in_lon is null
     or in_lat not between -90 and 90 or in_lon not between -180 and 180 then
    raise exception 'ensure_campsite needs a real coordinate';
  end if;

  -- Already there: nothing to do, and no quota spent.
  if exists (select 1 from public.campsites where id = in_id) then
    return in_id;
  end if;

  if not public.check_reveal_quota(caller) then
    raise exception 'too many requests, slow down';
  end if;

  insert into public.campsites (
    id, name, land_type, land_manager, latitude, longitude, description,
    source, is_published, land_verification, external_source, external_ref
  )
  values (
    in_id,
    coalesce(nullif(btrim(in_name), ''), 'Unnamed dispersed site'),
    in_land_type,
    coalesce(in_land_manager, ''),
    in_lat,
    in_lon,
    coalesce(in_description, ''),
    'overpass'::public.campsite_source,
    true,
    'unverified'::public.land_verification,
    'osm',
    in_id
  )
  on conflict (id) do nothing;

  return in_id;
end;
$$;

comment on function public.ensure_campsite(text, text, public.land_type, double precision, double precision, text, text) is
  'Materialise an OpenStreetMap campsite so check-ins, reviews and reports can reference it. OSM ids only.';

grant execute on function public.ensure_campsite(text, text, public.land_type, double precision, double precision, text, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- 3. Let an author see their own submission
-- ---------------------------------------------------------------------
-- The old policy was `using (is_published)`, so somebody who submitted a spot
-- could not see it — the app had no way to tell them their contribution had
-- been received, let alone what happened to it next.
drop policy if exists "public read: published campsites" on public.campsites;

create policy "read: published, or hidden-from-others, or mine"
  on public.campsites for select to anon, authenticated
  using ((is_published and not is_hidden) or submitted_by = auth.uid());

-- ---------------------------------------------------------------------
-- 4. Submissions require an account
-- ---------------------------------------------------------------------
-- Anonymous unmoderated writes into a table the map reads is a spam surface
-- with no upside now that sign-in exists. Signed-out campers keep their
-- device-local path, which is exactly what they have today.
drop policy if exists "public insert: user submissions only" on public.campsites;

create policy "insert: signed-in user submissions only"
  on public.campsites for insert to authenticated
  with check (
    source = 'user_submitted'
    and is_published = false
    and is_hidden = false
    and land_verification = 'unverified'
    and verified_land_id is null
    and rating = 0
    and review_count = 0
    and submitted_by = auth.uid()
  );

revoke insert on public.campsites from anon;

-- ---------------------------------------------------------------------
-- 5. Capacity, via a trigger instead of an impossible client UPDATE
-- ---------------------------------------------------------------------
/*
 * dataService.checkIn() has always followed its insert with
 * `update campsites set capacity_status = …`, and ignored the error. There
 * is no UPDATE policy and no UPDATE grant on public.campsites for
 * `authenticated` anywhere in this schema, so that write has never once
 * succeeded. Every pin has shown "Unknown" capacity since the feature
 * shipped.
 *
 * The check-in itself is the fact; the campsite's capacity is a summary of
 * it, so the database maintains it — same shape as refresh_campsite_rating.
 */
create or replace function public.refresh_campsite_capacity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.campsites c
     set capacity_status = new.capacity
   where c.id = new.campsite_id;
  return null;
end;
$$;

drop trigger if exists check_ins_refresh_capacity on public.check_ins;
create trigger check_ins_refresh_capacity
  after insert on public.check_ins
  for each row execute function public.refresh_campsite_capacity();

-- ---------------------------------------------------------------------
-- 6. Reviews that belong to a person
-- ---------------------------------------------------------------------
-- `author` was a free-text box: unverifiable, unattributable, and impossible
-- to moderate. It stays as a snapshot of the handle at write time (so a
-- deleted profile's review still reads sensibly) but the row now also knows
-- whose it is.
alter table public.campsite_reviews
  add column if not exists user_id   uuid references public.profiles(id) on delete set null,
  add column if not exists is_hidden boolean not null default false;

-- One review per person per site. Editing yours is an update, not a second row.
create unique index if not exists campsite_reviews_one_per_user
  on public.campsite_reviews (campsite_id, user_id)
  where user_id is not null;

drop policy if exists "public read: reviews"   on public.campsite_reviews;
drop policy if exists "public insert: reviews" on public.campsite_reviews;

create policy "read: visible reviews, plus my own"
  on public.campsite_reviews for select to anon, authenticated
  using (not is_hidden or user_id = auth.uid());

create policy "insert: my own review"
  on public.campsite_reviews for insert to authenticated
  with check (user_id = auth.uid() and is_hidden = false);

create policy "update: my own review"
  on public.campsite_reviews for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "delete: my own review"
  on public.campsite_reviews for delete to authenticated
  using (user_id = auth.uid());

revoke insert on public.campsite_reviews from anon;
grant update, delete on public.campsite_reviews to authenticated;

/*
 * The average must ignore hidden reviews.
 *
 * Without this, hiding an abusive or fraudulent review leaves its stars in
 * the site's rating — which is most of what the review was doing.
 */
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
             from public.campsite_reviews r
            where r.campsite_id = target and not r.is_hidden
         ), 0),
         review_count = (
           select count(*) from public.campsite_reviews r
            where r.campsite_id = target and not r.is_hidden
         )
   where c.id = target;
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Reporting bad content
-- ---------------------------------------------------------------------
/*
 * NOT THE SAME THING AS site_reports, and conflating them is how a
 * moderation queue fills with "road washed out".
 *
 *   site_reports    — about the PLACE. Gated, closed, impassable, occupied.
 *   content_reports — about the RECORD. Spam, wrong location, abuse.
 */
do $$ begin
  create type public.report_target as enum
    ('campsite', 'campsite_review', 'campsite_photo', 'poi');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.content_report_reason as enum
    ('spam', 'wrong_location', 'private_property', 'unsafe', 'abusive',
     'not_camping', 'other');
exception when duplicate_object then null; end $$;

create table if not exists public.content_reports (
  id          uuid primary key default gen_random_uuid(),
  target_kind public.report_target not null,
  -- text, because campsite ids are text and review/photo ids are uuid. No FK
  -- on purpose: a report has to survive the thing it reported.
  target_id   text not null,
  reporter_id uuid references public.profiles(id) on delete set null,
  reason      public.content_report_reason not null,
  detail      text,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,

  constraint content_reports_detail_len check (detail is null or length(detail) <= 1000)
);

create unique index if not exists content_reports_one_per_user
  on public.content_reports (target_kind, target_id, reporter_id)
  where reporter_id is not null;

create index if not exists content_reports_open_idx
  on public.content_reports (target_kind, target_id)
  where resolved_at is null;

alter table public.content_reports enable row level security;

drop policy if exists "insert: my own report" on public.content_reports;
drop policy if exists "read: my own reports"  on public.content_reports;

create policy "insert: my own report"
  on public.content_reports for insert to authenticated
  with check (reporter_id = auth.uid());

-- Reports are not public. A visible report count is a brigading tool.
create policy "read: my own reports"
  on public.content_reports for select to authenticated
  using (reporter_id = auth.uid());

grant select, insert on public.content_reports to authenticated;

/*
 * Auto-hide at three distinct reporters.
 *
 * Three is deliberately low: this is pre-launch, there is no moderator on
 * duty, and hiding is reversible while a bad campsite left on the map is
 * somebody driving to private land. Nothing is deleted.
 */
create or replace function public.auto_hide_reported_content()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reporters integer;
begin
  select count(distinct reporter_id) into reporters
    from public.content_reports
   where target_kind = new.target_kind
     and target_id   = new.target_id
     and resolved_at is null;

  if reporters < 3 then
    return null;
  end if;

  if new.target_kind = 'campsite' then
    update public.campsites set is_hidden = true where id = new.target_id;
  elsif new.target_kind = 'campsite_review' then
    update public.campsite_reviews set is_hidden = true
     where id = new.target_id::uuid;
    -- Recompute the average without the review just hidden.
    update public.campsites c
       set rating = coalesce((
             select round(avg(r.rating)::numeric, 1) from public.campsite_reviews r
              where r.campsite_id = c.id and not r.is_hidden), 0),
           review_count = (
             select count(*) from public.campsite_reviews r
              where r.campsite_id = c.id and not r.is_hidden)
     where c.id = (select campsite_id from public.campsite_reviews
                    where id = new.target_id::uuid);
  elsif new.target_kind = 'campsite_photo' then
    update public.campsite_photos set is_hidden = true
     where id = new.target_id::uuid;
  end if;

  return null;
end;
$$;

drop trigger if exists content_reports_auto_hide on public.content_reports;
create trigger content_reports_auto_hide
  after insert on public.content_reports
  for each row execute function public.auto_hide_reported_content();

-- ---------------------------------------------------------------------
-- 8. The read the client will actually use
-- ---------------------------------------------------------------------
/*
 * campsites_visible() gains the fields a campsite card needs, and learns to
 * respect is_hidden. The return table changes, so the function has to be
 * dropped and recreated — same dance migration 08 performs.
 *
 * WHAT IT STILL DOES NOT RETURN: any amenity column. water, toilet,
 * road_access, cell_* and stay_limit_days are all `not null default` in this
 * schema, so absence is indistinguishable from an observation — reading them
 * back would tell a camper there is no water at a site nobody has ever
 * surveyed. Making those columns nullable is the right fix and is a
 * migration of its own; until then the client leaves amenities empty.
 */
drop function if exists public.campsites_visible(double precision, double precision, double precision);

create or replace function public.campsites_visible(
  in_lat double precision, in_lon double precision, in_radius_miles double precision default 100
)
returns table (
  id text, name text, land_type public.land_type, land_manager text,
  description text, images text[],
  nearest_city text, state_province text, country text,
  latitude double precision, longitude double precision,
  is_stealth boolean, is_unlocked boolean, is_approximate boolean,
  capacity_status public.capacity_status,
  rating numeric, review_count integer,
  source public.campsite_source,
  is_published boolean, submitted_by uuid,
  distance_miles double precision
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
    where not c.is_hidden
      -- An author always sees their own submission, published or not.
      and (c.is_published or c.submitted_by = caller.uid)
      and st_dwithin(
            c.geom::geography,
            st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography,
            in_radius_miles * 1609.34)
  )
  select
    d.id,
    d.name,
    d.land_type,
    d.land_manager,
    d.description,
    d.images,
    d.nearest_city,
    d.state_province,
    d.country,
    case when d.is_stealth and not d.unlocked
         then round(st_y(d.geom)::numeric, 2)::double precision
         else st_y(d.geom) end,
    case when d.is_stealth and not d.unlocked
         then round(st_x(d.geom)::numeric, 2)::double precision
         else st_x(d.geom) end,
    d.is_stealth,
    d.unlocked,
    (d.is_stealth and not d.unlocked) as is_approximate,
    d.capacity_status,
    d.rating,
    d.review_count,
    d.source,
    d.is_published,
    d.submitted_by,
    (st_distance(
       d.geom::geography,
       st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography) / 1609.34)::double precision
  from candidate d, caller
  where not d.is_stealth
     or public.tier_rank(caller.tier) >= public.tier_rank(d.min_tier)
  order by 21
  limit 300;
$$;

grant execute on function public.campsites_visible(double precision, double precision, double precision)
  to anon, authenticated;

commit;

-- =====================================================================
--  POST-INSTALL
--
--  1. Re-run the campsite seed. It has never succeeded — scripts/
--     seedSupabase.ts crashed on the first row until the fix that ships
--     with this migration — so public.campsites is very likely empty:
--
--         npm run seed -- --sites
--
--     Confirm with: select count(*) from public.campsites;   -- expect 21
--
--  2. Nothing here backfills campsite_reviews.user_id. Any review written
--     before this migration keeps its free-text author and a null user_id,
--     which the read policy still shows and its owner cannot edit. There
--     should be none — reviews were never persisted at all.
--
--  3. To un-hide something auto-hidden by a bad-faith report, with the
--     service role key:
--
--         update public.campsites set is_hidden = false where id = '…';
--         update public.content_reports set resolved_at = now()
--          where target_kind = 'campsite' and target_id = '…';
-- =====================================================================