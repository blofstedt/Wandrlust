-- ---------------------------------------------------------------------
--  27. URBAN, SUBURBAN OR WILDERNESS
--
--  The second axis on a campsite pin. The first is provenance — who says
--  there is a place here — and it is carried by the pin's SHAPE. This is
--  what kind of place it is, and it is carried by the glyph inside.
--
--  NULLABLE ON PURPOSE, and it is the whole point of the column.
--
--  There is no 'unknown' member of the enum because an unknown setting is
--  not a kind of setting, it is the absence of an answer — the same reason
--  every scale in a spot report is nullable and must never be coalesced to
--  zero. A pin with no setting keeps the plain tent glyph and claims
--  nothing. Adding 'unknown' as a value would invite exactly the
--  `coalesce(setting, 'unknown')` that turns "nobody has said" into a
--  finding.
--
--  `setting_is_derived` records HOW we know. True means this app worked it
--  out from distance to the nearest mapped settlement, which is a guess
--  about a category and is wrong at the edges: two kilometres from a
--  village centre can be dense housing or open forest. False means a human
--  who was standing there said so, and a human always wins — the deriver
--  must never overwrite a stated answer.
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'campsite_setting') then
    create type public.campsite_setting as enum ('urban', 'suburban', 'wilderness');
  end if;
end
$$;

alter table public.campsites
  add column if not exists setting public.campsite_setting,
  add column if not exists setting_is_derived boolean not null default true;

comment on column public.campsites.setting is
  'Urban, suburban or wilderness. NULL means nobody has said — never coalesce it to a value.';
comment on column public.campsites.setting_is_derived is
  'True when this app inferred the setting from distance to the nearest mapped settlement; false when a human who was there stated it. A stated answer must never be overwritten by the deriver.';

-- ---------------------------------------------------------------------
--  The read path has to carry it, or the column may as well not exist.
--
--  A RETURNS TABLE signature cannot be changed by CREATE OR REPLACE, so
--  this is a drop and recreate. The body is unchanged apart from the two
--  new columns; the grants are restored explicitly below because a DROP
--  takes them with it — and `from public, anon, authenticated` on the
--  revoke, because a new function carries an implicit grant to PUBLIC that
--  revoking from the two roles alone does not remove.
-- ---------------------------------------------------------------------

drop function if exists public.campsites_visible(double precision, double precision, double precision);

create function public.campsites_visible(
  in_lat double precision,
  in_lon double precision,
  in_radius_miles double precision default 100
)
returns table (
  id text, name text, land_type public.land_type, land_manager text,
  description text, images text[], nearest_city text, state_province text,
  country text, latitude double precision, longitude double precision,
  is_stealth boolean, is_unlocked boolean, is_approximate boolean,
  capacity_status public.capacity_status, rating numeric, review_count integer,
  source public.campsite_source, is_published boolean, submitted_by uuid,
  setting public.campsite_setting, setting_is_derived boolean,
  distance_miles double precision
)
language sql
stable
security definer
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
    d.setting,
    d.setting_is_derived,
    (st_distance(
       d.geom::geography,
       st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography) / 1609.34)::double precision
  from candidate d, caller
  where not d.is_stealth
     or public.tier_rank(caller.tier) >= public.tier_rank(d.min_tier)
  order by 23
  limit 300;
$$;

revoke all on function public.campsites_visible(double precision, double precision, double precision)
  from public, anon, authenticated;
grant execute on function public.campsites_visible(double precision, double precision, double precision)
  to anon, authenticated, service_role;
