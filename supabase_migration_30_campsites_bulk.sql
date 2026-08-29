-- ---------------------------------------------------------------------------
-- Migration 30 — the whole shared campsite set, in one read.
-- ---------------------------------------------------------------------------
--
-- WHY THIS EXISTS
--
-- `campsites_visible` answers "what is near this point", takes a radius and
-- stops at 300 rows. That is the right shape for a camper moving around a
-- map, and it is the wrong shape for the first paint: opening the app meant
-- a round trip before a single free campground appeared, another on every
-- meaningful pan, and nothing survived closing the tab. The map spent its
-- first seconds looking empty, which reads as "there is nothing here" — the
-- one thing this app has decided it will never say by accident.
--
-- The whole shared set is small. At the time of writing it is 1,167 rows —
-- 832 BC recreation sites, 313 free campgrounds ingested from OpenStreetMap
-- and 22 curated spots — a few hundred kilobytes of JSON. So the client can
-- have all of it, once, store it on the device, and paint the map from disk
-- on every subsequent open while a refresh runs behind it.
--
-- WHAT IS DELIBERATELY NOT IN HERE
--
--   STEALTH SPOTS. Their position is entitlement-gated: `campsites_visible`
--   rounds the coordinates of a stealth site to ~2 km unless the caller's
--   trust tier has earned the sharp one. A bulk answer is written to disk and
--   read back for weeks by whoever is holding the phone, which outlives the
--   entitlement that produced it. Stealth spots therefore keep coming from
--   `campsites_visible`, per view, per caller, every time. There are none in
--   the table today; this function must stay correct on the day there are.
--
--   UNPUBLISHED SPOTS. A submission awaiting review is visible to its author
--   and to nobody else. That is a per-caller answer too, and it stays with
--   the per-view read.
--
-- So this returns exactly the set that is the same for every caller: published,
-- not hidden, not stealth. `is_stealth`, `is_unlocked` and `is_approximate`
-- come back as constants rather than being dropped, so one row shape serves
-- both reads and the client maps them with the same code.
--
-- ON THE LIMIT: it is a real ceiling, not a formality. A client that asks for
-- `in_limit` and gets exactly that many rows back has been given a TRUNCATED
-- answer and must treat it as one — it cannot conclude that a spot missing
-- from the list has gone away. `fetchAllSharedCampsites` in `dataService.ts`
-- carries the other half of that contract.

create or replace function public.campsites_bulk(in_limit integer default 5000)
returns table (
  id text,
  name text,
  land_type public.land_type,
  land_manager text,
  description text,
  images text[],
  nearest_city text,
  state_province text,
  country text,
  latitude double precision,
  longitude double precision,
  is_stealth boolean,
  is_unlocked boolean,
  is_approximate boolean,
  capacity_status public.capacity_status,
  rating numeric,
  review_count integer,
  source public.campsite_source,
  is_published boolean,
  submitted_by uuid,
  setting public.campsite_setting,
  setting_is_derived boolean
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    c.id, c.name, c.land_type, c.land_manager, c.description, c.images,
    c.nearest_city, c.state_province, c.country,
    st_y(c.geom), st_x(c.geom),
    false, false, false,
    c.capacity_status, c.rating, c.review_count, c.source, c.is_published,
    c.submitted_by, c.setting, c.setting_is_derived
  from public.campsites c
  where c.is_published
    and not c.is_hidden
    and not c.is_stealth
  -- Stable across calls, so a truncated answer truncates the same way twice
  -- rather than shuffling which spots the device happens to hold.
  order by c.id
  limit greatest(1, least(coalesce(in_limit, 5000), 20000));
$$;

-- The function is a public read and is meant to be callable by anyone with the
-- anon key — that is the same set of rows the `campsites` read policy already
-- allows. The grant is named anyway rather than left to the implicit PUBLIC
-- one, because six migrations in this repo have now been bitten by assuming
-- that ACL was something other than what it is.
revoke execute on function public.campsites_bulk(integer) from public;
grant execute on function public.campsites_bulk(integer) to anon, authenticated;
