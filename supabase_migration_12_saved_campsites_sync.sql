-- =====================================================================
--  Migration 12 — saved campsites actually sync
-- =====================================================================
--
-- THE BUG THIS FIXES
-- ---------------------------------------------------------------------
-- Tapping the bookmark on a campsite wrote to browser storage and stopped
-- there. `public.saved_campsites` has existed since migration 04, with its
-- table, its primary key and its owner-only RLS policy, and no client code
-- ever inserted a row into it. So a camper's saved list died with the
-- browser profile: reinstall the app, clear the site data, or open it on a
-- second device, and every spot they had bookmarked was gone.
--
-- Two things were missing on this side of the wire.
--
-- 1. `user_id` is `not null` with no default. The only sane value a client
--    can supply is its own `auth.uid()`, which the RLS policy then checks it
--    against anyway — so making the client send it is pure ceremony that a
--    caller can only get wrong. It gets a default.
--
-- 2. There was no way to READ the list back. `saved_campsites` holds ids,
--    not campsites, and the campsite rows behind them cannot simply be
--    selected: `campsites` carries stealth sites whose exact coordinates are
--    gated behind the trust tier and the unlock ledger. A plain
--    `select ... where id in (...)` would hand a tourist the precise position
--    of every stealth site they had bookmarked, which is the one thing the
--    fuzzing in `campsites_visible` exists to prevent.
--
-- So the read is an RPC that reuses exactly the same rules.
--
-- Nothing here is destructive. It adds a default and a function.
-- ---------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------
-- 1. The caller is always the owner
-- ---------------------------------------------------------------------
-- The RLS policy ("all: own saved") already requires user_id = auth.uid()
-- on both read and write. Defaulting the column to the same expression means
-- an insert never has to name it, and a signed-out insert still fails —
-- auth.uid() is null, and the column is not null.
alter table public.saved_campsites
  alter column user_id set default auth.uid();

-- ---------------------------------------------------------------------
-- 2. Reading your saved list back
-- ---------------------------------------------------------------------
/*
 * campsites_saved() is campsites_visible() with the radius swapped for a
 * membership test against saved_campsites. Every other rule is carried over
 * deliberately and must stay in step with it:
 *
 *   - hidden rows are excluded
 *   - unpublished rows are visible only to their author
 *   - a stealth site the caller has not unlocked comes back rounded to two
 *     decimal places (~1 km) with is_approximate = true
 *   - a stealth site above the caller's trust tier does not come back at all
 *   - NO amenity columns. water, toilet, road_access, cell_* and
 *     stay_limit_days are `not null default` in this schema, so absence is
 *     indistinguishable from an observation. Reading them back would tell a
 *     camper there is no water at a site nobody has ever surveyed. The client
 *     leaves amenities empty and the local copy keeps whatever the camper
 *     actually recorded.
 *
 * A saved row whose campsite is now hidden, or which sits above the caller's
 * tier, silently drops out of this result. That is correct: the row stays in
 * saved_campsites, so if the site is unhidden or the camper earns the tier it
 * comes back. The client is careful not to read a short result as "these were
 * unsaved" — see fetchSavedCampsitesRemote.
 *
 * security definer for the same reason campsites_visible is: the fuzzing has
 * to happen server-side, where the caller cannot reach around it.
 */
create or replace function public.campsites_saved()
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
  saved_at timestamptz, notes text
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
      s.saved_at,
      s.notes,
      exists (
        select 1 from public.stealth_unlocks u, caller
        where u.user_id = caller.uid and u.campsite_id = c.id
      ) as unlocked
    from public.saved_campsites s
    join public.campsites c on c.id = s.campsite_id, caller
    where caller.uid is not null
      and s.user_id = caller.uid
      and not c.is_hidden
      and (c.is_published or c.submitted_by = caller.uid)
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
    d.saved_at,
    d.notes
  from candidate d, caller
  where not d.is_stealth
     or public.tier_rank(caller.tier) >= public.tier_rank(d.min_tier)
  order by d.saved_at desc
  limit 500;
$$;

-- Signed-out callers get an empty set from the `caller.uid is not null`
-- guard rather than an error, which is what keeps the client's "never throws"
-- contract cheap to honour.
grant execute on function public.campsites_saved() to authenticated;

commit;
