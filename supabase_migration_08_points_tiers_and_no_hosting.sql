-- =====================================================================
--  Wandrlust migration 08
--
--  Three changes, in this order because they depend on each other:
--
--    1. HOSTING IS REMOVED. Listing private property put the project in the
--       middle of a stranger sleeping on someone's land — insurance, liability,
--       and a duty of care this app cannot carry. The tables, the booking
--       flow, the double-blind reviews and the host aggregates all go.
--
--    2. TOKENS BECOME POINTS. Same append-only ledger, same server-side-only
--       faucet, new name. "Tokens" reads like something you buy. Points are
--       something you earn, and the point of them is the tier they unlock.
--
--    3. THREE TIERS BECOME FIVE. A ladder with one rung in the middle gives
--       people nothing to climb toward for months at a time.
--
--  Enum values cannot be dropped in place, so both enums are rebuilt and
--  swapped. That means dropping and recreating every function that names
--  them in its signature or body. All of those are reproduced below.
--
--  Run AFTER 07. This migration is idempotent-ish: it guards with
--  `if exists` where it can, but it is not designed to be run twice.
-- =====================================================================

begin;

-- =====================================================================
--  1. HOSTING — gone
-- =====================================================================

drop trigger if exists bookings_notify on public.bookings;
drop function if exists public.notify_booking_change() cascade;

drop trigger if exists booking_reviews_finalise on public.booking_reviews;
drop function if exists public.finalise_booking_reviews() cascade;

-- Order matters: reviews reference bookings, bookings reference listings.
drop table if exists public.booking_reviews cascade;
drop table if exists public.bookings        cascade;
drop table if exists public.host_listings   cascade;

alter table public.profiles
  drop column if exists is_host,
  drop column if exists host_rating,
  drop column if exists host_review_count,
  drop column if exists guest_rating,
  drop column if exists guest_review_count;

alter table public.user_settings
  drop column if exists notify_booking_updates;

-- =====================================================================
--  2. TOKENS -> POINTS
--
--  The reason enum loses its three hosting values at the same time, which
--  is why it is rebuilt rather than renamed.
-- =====================================================================

-- Functions that name token_reason or return balances. Recreated below.
drop function if exists public.grant_tokens(uuid, integer, public.token_reason, text, text, text);
drop function if exists public.spend_tokens(uuid, integer, public.token_reason, text, text);
drop function if exists public.token_balance(uuid);

drop materialized view if exists public.token_balances;

create type public.points_reason as enum (
  'check_in', 'check_out', 'scout_new_site', 'verify_amenity',
  'telemetry_batch', 'hazard_report', 'early_hazard_bonus',
  'photo_upload', 'poi_submit',
  'unlock_stealth', 'download_map_pack',
  'admin_grant', 'admin_clawback'
);

-- Ledger. Hosting rows are deleted before the column is retyped, because
-- 'host_stay' and 'book_stay' have no equivalent in the new enum.
delete from public.token_ledger
 where reason::text in ('host_stay', 'book_stay', 'mutual_review_bonus');

alter table public.token_ledger
  alter column reason type public.points_reason using reason::text::public.points_reason;

alter table public.token_ledger rename to points_ledger;
alter table public.points_ledger rename constraint token_ledger_delta_nonzero to points_ledger_delta_nonzero;
alter table public.points_ledger rename constraint token_ledger_delta_sane    to points_ledger_delta_sane;
alter index  public.token_ledger_user_idx rename to points_ledger_user_idx;

comment on table public.points_ledger is
  'Append-only points ledger. Earned only, never sold, never redeemable for money.';

-- Rules table.
delete from public.token_rules
 where reason::text in ('host_stay', 'book_stay', 'mutual_review_bonus');

alter table public.token_rules
  alter column reason type public.points_reason using reason::text::public.points_reason;

alter table public.token_rules rename to points_rules;

drop type if exists public.token_reason;

create materialized view public.points_balances as
  select user_id, sum(delta)::integer as balance
  from public.points_ledger group by user_id;

create unique index points_balances_user_idx on public.points_balances (user_id);

create or replace function public.points_balance(in_user uuid)
returns integer language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(delta), 0)::integer
  from public.points_ledger where user_id = in_user;
$$;

-- Faucet. Server-side only: clients cannot mint.
create or replace function public.grant_points(
  in_user uuid, in_amount integer, in_reason public.points_reason,
  in_ref_table text default null, in_ref_id text default null, in_memo text default null
)
returns bigint language plpgsql security definer
set search_path = public, pg_temp
as $$
declare new_id bigint;
begin
  if in_amount <= 0 then
    raise exception 'grant_points requires a positive amount';
  end if;

  insert into public.points_ledger (user_id, delta, reason, ref_table, ref_id, memo)
  values (in_user, in_amount, in_reason, in_ref_table, in_ref_id, in_memo)
  returning id into new_id;

  return new_id;
end;
$$;

-- Sink. Refuses to overdraw.
create or replace function public.spend_points(
  in_user uuid, in_amount integer, in_reason public.points_reason,
  in_ref_table text default null, in_ref_id text default null
)
returns integer language plpgsql security definer
set search_path = public, pg_temp
as $$
declare current_balance integer;
begin
  if in_amount <= 0 then
    raise exception 'spend_points requires a positive amount';
  end if;

  -- Lock the PROFILE row, not the ledger: a user with no ledger rows yet
  -- would otherwise lock nothing and two concurrent spends could both pass.
  perform 1 from public.profiles where id = in_user for update;

  select coalesce(sum(delta), 0)::integer into current_balance
  from public.points_ledger where user_id = in_user;

  if current_balance < in_amount then
    raise exception 'insufficient points: have %, need %', current_balance, in_amount
      using errcode = 'check_violation';
  end if;

  insert into public.points_ledger (user_id, delta, reason, ref_table, ref_id)
  values (in_user, -in_amount, in_reason, in_ref_table, in_ref_id);

  return current_balance - in_amount;
end;
$$;

-- =====================================================================
--  2b. PREFLIGHT — objects from migration 02 section 7
--
--  Section 7 of migration 02 ("TRUST TIERS & STEALTH SITES") did not land on
--  at least one live database: `campsites.min_tier` was missing, which took
--  this migration down with 42703 when it tried to retype the column.
--  Everything before that section was present, so the break is section 7
--  onward — the campsites columns, the stealth_unlocks table, and the
--  functions that read them.
--
--  Rather than assume, create whatever is absent. Every statement here is a
--  no-op on a database where 02 ran in full, so this is safe either way.
--  These use the CURRENT trust_tier type; the swap below retypes them.
-- =====================================================================

alter table public.campsites
  add column if not exists is_stealth          boolean not null default false,
  add column if not exists min_tier            public.trust_tier not null default 'tourist',
  add column if not exists submitted_by        uuid references public.profiles(id) on delete set null,
  add column if not exists capacity_status     public.capacity_status not null default 'unknown',
  add column if not exists capacity_updated_at timestamptz;

create index if not exists campsites_stealth_idx
  on public.campsites (is_stealth, min_tier);

create table if not exists public.stealth_unlocks (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  campsite_id text not null references public.campsites(id) on delete cascade,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, campsite_id)
);

alter table public.stealth_unlocks enable row level security;

drop policy if exists "read: own unlocks" on public.stealth_unlocks;
create policy "read: own unlocks" on public.stealth_unlocks
  for select using (user_id = auth.uid());

grant select on public.stealth_unlocks to authenticated;

-- =====================================================================
--  3. FIVE TIERS
--
--  tourist -> camper -> scout -> trailblazer -> nomad
--
--  'contributor' becomes 'scout' (the middle rung), so nobody who earned
--  that tier is knocked back down the ladder by the rename itself. The
--  thresholds are re-spaced for five rungs; recompute_trust() at the end
--  of this migration re-evaluates every profile against them.
-- =====================================================================

drop function if exists public.tier_rank(public.trust_tier);
drop function if exists public.recompute_trust(uuid);
drop function if exists public.campsites_visible(double precision, double precision, double precision);
drop function if exists public.unlock_stealth_site(text);

alter table public.profiles  alter column trust_tier drop default;
alter table public.campsites alter column min_tier   drop default;

create type public.trust_tier_new as enum
  ('tourist', 'camper', 'scout', 'trailblazer', 'nomad');

alter table public.profiles
  alter column trust_tier type public.trust_tier_new
  using (case trust_tier::text
           when 'contributor' then 'scout'
           else trust_tier::text
         end)::public.trust_tier_new;

alter table public.campsites
  alter column min_tier type public.trust_tier_new
  using (case min_tier::text
           when 'contributor' then 'scout'
           else min_tier::text
         end)::public.trust_tier_new;

drop type public.trust_tier;
alter type public.trust_tier_new rename to trust_tier;

alter table public.profiles
  alter column trust_tier set default 'tourist'::public.trust_tier;
alter table public.campsites
  alter column min_tier set default 'tourist'::public.trust_tier;

create or replace function public.tier_rank(t public.trust_tier)
returns integer language sql immutable as $$
  select case t
           when 'tourist'     then 1
           when 'camper'      then 2
           when 'scout'       then 3
           when 'trailblazer' then 4
           when 'nomad'       then 5
         end;
$$;

/*
 * Score is unchanged — check-ins, scouted sites and verifications. Only the
 * banding is new. Kept in sync by hand with TIERS in src/config/tiers.ts;
 * if you change a number here, change it there too.
 */
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
    when score >= 400 then 'nomad'::public.trust_tier
    when score >= 180 then 'trailblazer'::public.trust_tier
    when score >= 70  then 'scout'::public.trust_tier
    when score >= 20  then 'camper'::public.trust_tier
    else 'tourist'::public.trust_tier
  end;

  update public.profiles
     set trust_score = score, trust_tier = tier, updated_at = now()
   where id = in_user;

  return tier;
end;
$$;

/*
 * The single read path for campsites. Unchanged except for the type swap.
 *   tourist / camper : public-land sites only. Stealth pins invisible.
 *   scout            : sees that a stealth pin exists, fuzzed ~2 km.
 *   trailblazer+     : exact coords, after unlocking with points.
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
    from public.campsites c
    where c.is_published
      and st_dwithin(
            c.geom::geography,
            st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography,
            in_radius_miles * 1609.34)
  )
  select
    d.id,
    d.name,
    d.land_type,
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
    (st_distance(
       d.geom::geography,
       st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography) / 1609.34)::double precision
  from candidate d, caller
  where not d.is_stealth
     or public.tier_rank(caller.tier) >= public.tier_rank(d.min_tier)
  order by 12
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
  if public.tier_rank(coalesce(caller_tier, 'tourist')) < public.tier_rank('trailblazer') then
    raise exception 'trailblazer tier required to unlock exact coordinates';
  end if;

  if not public.check_reveal_quota(caller) then
    raise exception 'reveal rate limit reached; try again later'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.stealth_unlocks
              where user_id = caller and campsite_id = in_campsite) then
    return query select site.latitude, site.longitude, public.points_balance(caller);
    return;
  end if;

  select abs(amount) into cost from public.points_rules where reason = 'unlock_stealth';
  new_balance := public.spend_points(caller, coalesce(cost, 250), 'unlock_stealth',
                                     'campsites', in_campsite);

  insert into public.stealth_unlocks (user_id, campsite_id) values (caller, in_campsite);
  insert into public.reveal_log (user_id, campsite_id) values (caller, in_campsite);

  return query select site.latitude, site.longitude, new_balance;
end;
$$;

-- =====================================================================
--  4. Trigger functions that referenced the old names
-- =====================================================================

create or replace function public.accept_telemetry_batch()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare reward integer; cap integer; daily integer;
begin
  if new.point_count < 10 then
    new.accepted := false;
    new.reject_reason := 'fewer than 10 points';
    return new;
  end if;

  if st_length(new.path::geography) < 200 then
    new.accepted := false;
    new.reject_reason := 'path shorter than 200 m';
    return new;
  end if;

  new.accepted := true;

  select amount, daily_cap into reward, cap
  from public.points_rules where reason = 'telemetry_batch';

  select count(*) into daily
  from public.points_ledger
  where user_id = new.user_id
    and reason = 'telemetry_batch'
    and created_at > now() - interval '24 hours';

  if cap is null or daily < cap then
    perform public.grant_points(new.user_id, coalesce(reward, 5), 'telemetry_batch',
                                'telemetry_batches', new.id::text);
  end if;

  return new;
end;
$$;

create or replace function public.reward_hazard_confirmation()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare confirmations integer; reporter uuid;
begin
  select count(*), max(h.reporter_id) into confirmations, reporter
  from public.hazard_confirmations hc
  join public.hazard_reports h on h.id = hc.hazard_id
  where hc.hazard_id = new.hazard_id;

  if confirmations = 3 and reporter is not null then
    perform public.grant_points(
      reporter,
      (select amount from public.points_rules where reason = 'early_hazard_bonus'),
      'early_hazard_bonus', 'hazard_reports', new.hazard_id::text
    );
  end if;

  return new;
end;
$$;

-- =====================================================================
--  5. Grants and policies for the renamed objects
-- =====================================================================

alter table public.points_ledger enable row level security;
alter table public.points_rules  enable row level security;

drop policy if exists "read: own ledger"  on public.points_ledger;
drop policy if exists "read: token rules" on public.points_rules;

create policy "read: own ledger" on public.points_ledger
  for select using (user_id = auth.uid());

create policy "read: points rules" on public.points_rules
  for select using (true);

grant select on public.points_rules to anon, authenticated;
grant select on public.points_ledger to authenticated;

grant execute on function
  public.points_balance(uuid),
  public.tier_rank(public.trust_tier),
  public.campsites_visible(double precision, double precision, double precision),
  public.unlock_stealth_site(text)
  to authenticated;

-- Minting and spending stay server-side. No client role gets these.
revoke all on function
  public.grant_points(uuid, integer, public.points_reason, text, text, text),
  public.spend_points(uuid, integer, public.points_reason, text, text)
  from anon, authenticated;

-- =====================================================================
--  6. Re-band every existing profile against the five-tier ladder
-- =====================================================================

do $$
declare r record;
begin
  for r in select id from public.profiles loop
    perform public.recompute_trust(r.id);
  end loop;
end;
$$;

commit;

-- After this migration, the balances view is stale until refreshed:
--   refresh materialized view concurrently public.points_balances;