-- =====================================================================
--  Wandrlust migration 13
--
--  BEACON — spot discovery, evidence tiers, and a model that learns.
--
--  WHAT THIS ADDS
--
--  Beacon lets a camper drop a pin and ask "could I sleep near here?".
--  The app scans public map data, scores what it finds, and returns at most
--  three candidates. Campers who actually stay somewhere push that place up
--  an evidence ladder, and every outcome — good night, parking ticket, moved
--  on at 2am — is fed back into the ranking model.
--
--  THE ONE RULE THIS SCHEMA ENFORCES
--
--  An algorithm can never mark a place as camper-approved. `beacon_tier`
--  starts at 'lead' and there is no code path anywhere in this file that
--  promotes a spot without an accepted proof-of-presence from a real account.
--  A grey pin means "public map data suggests this, nobody has been there".
--  That is the honest ceiling for a guess, and it is enforced here rather
--  than in the UI, because UI copy drifts and constraints do not.
--
--  HOW THE LEARNING WORKS, IN ONE PARAGRAPH
--
--  Every candidate is stored with the feature tokens that produced it
--  ('land=blm', 'road=residential', 'sign:no_parking=absent', ...). Every
--  outcome later attaches a label to that same token set. `beacon_signals`
--  keeps a good/bad tally per (token, region); `beacon_relearn()` turns those
--  tallies into Laplace-smoothed log-odds weights; `beacon_score()` sums the
--  weights of a candidate's tokens, blending the region's own opinion toward
--  the global one in proportion to how much the region has actually seen.
--  That last part matters: "residential street parking is fine" is true in
--  rural Alberta and false in Vancouver, and nobody should have to hand-code
--  which is which.
--
--  The smoothing constant is deliberately large. A token with three
--  observations gets a weight near zero, so early on the model simply defers
--  to the hand-written rules. Three campers are an anecdote, not evidence.
--
--  WHAT THIS DELIBERATELY DOES NOT DO
--
--  It does not claim a spot is legal. It records what public data says, what
--  campers report, and how confident that combination makes it — and every
--  read path carries the caveat with the data.
--
--  It does not prove someone stayed four hours. A browser has no background
--  geolocation: when the tab is closed nothing is recorded. What the dwell
--  check actually proves is that the device was inside a 50 m circle at two
--  moments four hours apart, plus whatever pings landed in between while the
--  app happened to be open. `beacon_verifications.dwell_minutes` is that
--  endpoint span and nothing more. The UI says so in those words.
--
--  Run AFTER 12.
-- =====================================================================


-- ---------------------------------------------------------------------
--  0. NEW POINTS REASONS
--
--  Postgres will not let a new enum value be USED in the transaction that
--  created it, so these two statements run on their own, before the main
--  transaction below. `if not exists` makes the whole file safe to re-run.
-- ---------------------------------------------------------------------

alter type public.points_reason add value if not exists 'beacon_verify';
alter type public.points_reason add value if not exists 'beacon_takedown';


begin;

-- ---------------------------------------------------------------------
--  1. ENUMS
-- ---------------------------------------------------------------------

do $$ begin
  create type public.beacon_tier as enum ('lead', 'reported', 'confirmed', 'withdrawn');
exception when duplicate_object then null; end $$;

comment on type public.beacon_tier is
  'lead = public data suggests it, nobody has been there. reported = one camper stayed and vouched. confirmed = several campers, recently. withdrawn = someone got in trouble here.';

do $$ begin
  create type public.beacon_generator as enum ('public_land', 'urban');
exception when duplicate_object then null; end $$;

-- The outcomes a camper can report. Only 'good' is good news; every other
-- value takes the spot off the map immediately and teaches the model that
-- whatever produced it was wrong.
do $$ begin
  create type public.beacon_outcome as enum (
    'good', 'ticketed', 'asked_to_leave', 'posted_no_parking', 'gone'
  );
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------
--  2. SPOTS
-- ---------------------------------------------------------------------

create table if not exists public.beacon_spots (
  id                uuid primary key default gen_random_uuid(),
  geom              geometry(Point, 4326) not null,
  tier              public.beacon_tier not null default 'lead',
  generator         public.beacon_generator not null,

  -- Plain-English, both of them. `label` is what the place is ("gravel
  -- pullout off a forest road"); `land_basis` is why we think you might be
  -- allowed to sleep there ("inside BLM land where dispersed camping is the
  -- general rule"). Both are shown to the camper verbatim.
  label             text,
  land_basis        text,

  -- The feature vector, exactly as it was at discovery time. `tokens` is a
  -- json array of strings and is the sole input to the learned score. Storing
  -- it rather than recomputing it is what makes later outcomes trainable:
  -- the model learns from what we actually believed, not from what we would
  -- believe today.
  features          jsonb not null default '{}'::jsonb,
  region            text not null default '*',

  rule_score        double precision not null default 0,
  model_score       double precision not null default 0,

  -- 'unknown' | 'clear' | 'restricted'. 'unknown' is the honest default and
  -- it is NOT the same as 'clear' — see beacon_effective_score().
  sign_evidence     text not null default 'unknown',

  verify_count      integer not null default 0,
  discovered_at     timestamptz not null default now(),
  last_confirmed_at timestamptz,
  withdrawn_at      timestamptz,
  withdrawn_reason  text,

  constraint beacon_spots_sign_evidence_known
    check (sign_evidence in ('unknown', 'clear', 'restricted'))
);

create index if not exists beacon_spots_geom_idx on public.beacon_spots using gist (geom);
create index if not exists beacon_spots_tier_idx on public.beacon_spots (tier) where withdrawn_at is null;

-- ~1 m. Two scans of the same lay-by must not stack up two pins.
create unique index if not exists beacon_spots_dedupe_idx on public.beacon_spots (
  round(st_y(geom)::numeric, 5),
  round(st_x(geom)::numeric, 5)
);

comment on table public.beacon_spots is
  'Candidate overnight spots. Tier is evidence, not certainty: nothing reaches ''confirmed'' without accepted proof-of-presence from separate accounts.';


-- ---------------------------------------------------------------------
--  3. SCAN CACHE
--
--  A grid cell scanned by anyone in the last 48 hours is served from here.
--  This is the difference between Beacon being free to run and Beacon
--  hammering Overpass on every pin drop — and a cache hit deliberately does
--  NOT consume one of the camper's three tokens, because they did not cost
--  us anything.
-- ---------------------------------------------------------------------

create table if not exists public.beacon_scans (
  id          bigint generated always as identity primary key,
  geom        geometry(Point, 4326) not null,
  radius_m    integer not null,
  found_count integer not null default 0,
  sources     jsonb not null default '{}'::jsonb,
  scanned_at  timestamptz not null default now()
);

create index if not exists beacon_scans_geom_idx on public.beacon_scans using gist (geom);
create index if not exists beacon_scans_time_idx on public.beacon_scans (scanned_at desc);


-- ---------------------------------------------------------------------
--  4. RATE LIMIT
--
--  Three beacons per twelve hours, in Postgres rather than in a per-process
--  Map — the API runs as a serverless function, so an in-memory counter is
--  a counter that resets whenever the platform feels like it. Same shape as
--  scrape_guard in migration 02.
-- ---------------------------------------------------------------------

create table if not exists public.beacon_quota (
  user_id        uuid primary key references public.profiles(id) on delete cascade,
  window_start   timestamptz not null default now(),
  used_in_window integer not null default 0
);


-- ---------------------------------------------------------------------
--  5. PROOF OF PRESENCE
-- ---------------------------------------------------------------------

create table if not exists public.beacon_presence_pings (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  spot_id      uuid not null references public.beacon_spots(id) on delete cascade,
  geom         geometry(Point, 4326) not null,
  accuracy_m   double precision,
  client_flags jsonb not null default '{}'::jsonb,
  at           timestamptz not null default now()
);

create index if not exists beacon_pings_user_spot_idx on public.beacon_presence_pings (user_id, spot_id, at desc);
create index if not exists beacon_pings_geom_idx on public.beacon_presence_pings using gist (geom);

comment on table public.beacon_presence_pings is
  'Location samples while a camper is parked at a spot. Sparse by nature — browsers do not report location with the tab closed, so absence of pings means nothing.';

create table if not exists public.beacon_verifications (
  id            uuid primary key default gen_random_uuid(),
  spot_id       uuid not null references public.beacon_spots(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  arrived_at    timestamptz not null,
  submitted_at  timestamptz not null default now(),
  dwell_minutes integer not null,
  photo_path    text,
  answers       jsonb not null default '{}'::jsonb,
  accepted      boolean not null default false,
  reject_reason text,
  created_at    timestamptz not null default now()
);

-- One accepted verification per camper per spot. Otherwise a single person
-- could walk a 'lead' all the way to green on their own, which is exactly the
-- thing the tier ladder exists to prevent.
create unique index if not exists beacon_verifications_one_per_user_idx
  on public.beacon_verifications (spot_id, user_id) where accepted;

create table if not exists public.beacon_reports (
  id         uuid primary key default gen_random_uuid(),
  spot_id    uuid not null references public.beacon_spots(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  outcome    public.beacon_outcome not null,
  detail     text,
  created_at timestamptz not null default now()
);

create index if not exists beacon_reports_spot_idx on public.beacon_reports (spot_id, created_at desc);


-- ---------------------------------------------------------------------
--  6. THE MODEL
-- ---------------------------------------------------------------------

create table if not exists public.beacon_signals (
  token      text not null,
  region     text not null default '*',
  good_count integer not null default 0,
  bad_count  integer not null default 0,
  weight     double precision not null default 0,
  updated_at timestamptz not null default now(),
  primary key (token, region)
);

comment on table public.beacon_signals is
  'Learned per-token log-odds weights, tallied from real camper outcomes. Region ''*'' is the global row. Readable by anyone: a ranking nobody can inspect is a ranking nobody should trust.';


-- ---------------------------------------------------------------------
--  7. SCORING
-- ---------------------------------------------------------------------

-- Sum the learned weights of a candidate's tokens.
--
-- The blend is the interesting bit. A region's own tally is trusted in
-- proportion to how much it has seen: with n observations it gets
-- n/(n+20) of the vote and the global weight gets the rest. So a region
-- nobody has camped in behaves exactly like the global average, and a
-- region with hundreds of stays governs itself.
create or replace function public.beacon_score(
  in_tokens text[],
  in_region text default '*'
)
returns double precision
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with t as (select unnest(coalesce(in_tokens, '{}'::text[])) as token),
  scored as (
    select
      coalesce(r.weight, 0)                    as region_weight,
      coalesce(r.good_count + r.bad_count, 0)  as region_n,
      coalesce(g.weight, 0)                    as global_weight
    from t
    left join public.beacon_signals r
      on r.token = t.token and r.region = coalesce(in_region, '*')
    left join public.beacon_signals g
      on g.token = t.token and g.region = '*'
  )
  select coalesce(sum(
      (region_n::double precision / (region_n + 20)) * region_weight
    + (1 - region_n::double precision / (region_n + 20)) * global_weight
  ), 0)
  from scored;
$$;

grant execute on function public.beacon_score(text[], text) to anon, authenticated;

-- Rebuild every weight from the outcomes on record.
--
-- A full rebuild rather than an incremental bump, because outcomes get
-- corrected — a spot withdrawn in error and restored has to be able to move
-- a weight back DOWN, and a counter that only ever increments cannot.
create or replace function public.beacon_relearn()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare token_rows integer;
begin
  -- `on commit drop` clears this at the end of the transaction, but a second
  -- call inside the same transaction would still collide. Cheap insurance.
  drop table if exists beacon_obs;

  create temp table beacon_obs on commit drop as
    -- An accepted verification is a good outcome for every token that put
    -- the spot on the map.
    select jsonb_array_elements_text(s.features -> 'tokens') as token,
           s.region                                          as region,
           1 as good, 0 as bad
      from public.beacon_verifications v
      join public.beacon_spots s on s.id = v.spot_id
     where v.accepted
       and jsonb_typeof(s.features -> 'tokens') = 'array'
    union all
    -- Any outcome other than 'good' is a bad one. A ticket is the strongest
    -- signal in the whole system and it is weighted the same as every other
    -- bad outcome on purpose: the model should not need to know how badly
    -- the night went, only that it went badly.
    select jsonb_array_elements_text(s.features -> 'tokens'),
           s.region,
           0, 1
      from public.beacon_reports rp
      join public.beacon_spots s on s.id = rp.spot_id
     where rp.outcome <> 'good'
       and jsonb_typeof(s.features -> 'tokens') = 'array';

  delete from public.beacon_signals;

  insert into public.beacon_signals (token, region, good_count, bad_count)
  select token, region, sum(good)::integer, sum(bad)::integer
    from beacon_obs
   group by token, region
  on conflict (token, region) do update
    set good_count = excluded.good_count,
        bad_count  = excluded.bad_count;

  -- The global row for each token is every region's observations pooled.
  insert into public.beacon_signals (token, region, good_count, bad_count)
  select token, '*', sum(good)::integer, sum(bad)::integer
    from beacon_obs
   group by token
  on conflict (token, region) do update
    set good_count = excluded.good_count,
        bad_count  = excluded.bad_count;

  -- Laplace-smoothed log-odds. alpha = 5 is a strong prior and that is the
  -- point: at 3 good / 0 bad a token earns a weight of 0.47, which barely
  -- reorders anything. At 50 / 0 it earns 2.4 and genuinely leads. The model
  -- is allowed to be confident only once it has earned the right.
  update public.beacon_signals
     set weight = ln(
           ((good_count + 5)::double precision / (good_count + bad_count + 10))
           / (1 - (good_count + 5)::double precision / (good_count + bad_count + 10))
         ),
         updated_at = now();

  select count(*)::integer into token_rows from public.beacon_signals;
  return token_rows;
end;
$$;

comment on function public.beacon_relearn() is
  'Rebuilds every learned weight from recorded outcomes. Safe to run at any time; runs nightly via beacon_maintenance().';

-- What the model has actually learned, in a shape the UI can show a camper.
-- Learning nobody can see is not learning anybody should trust.
create or replace function public.beacon_model_summary(in_region text default '*')
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'region', coalesce(in_region, '*'),
    'stays_recorded', (select count(*) from public.beacon_verifications where accepted),
    'reports_recorded', (select count(*) from public.beacon_reports where outcome <> 'good'),
    'observations_here', coalesce((
      select sum(good_count + bad_count)
        from public.beacon_signals
       where region = coalesce(in_region, '*')
    ), 0),
    'trusts_most', coalesce((
      select jsonb_agg(token order by weight desc)
        from (select token, weight from public.beacon_signals
               where region = coalesce(in_region, '*') and weight > 0.3
               order by weight desc limit 3) top
    ), '[]'::jsonb),
    'trusts_least', coalesce((
      select jsonb_agg(token order by weight asc)
        from (select token, weight from public.beacon_signals
               where region = coalesce(in_region, '*') and weight < -0.3
               order by weight asc limit 3) bottom
    ), '[]'::jsonb)
  );
$$;

grant execute on function public.beacon_model_summary(text) to anon, authenticated;


-- ---------------------------------------------------------------------
--  8. RATE LIMIT CLAIM
-- ---------------------------------------------------------------------

create or replace function public.claim_beacon_token()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller     uuid := auth.uid();
  q          public.beacon_quota%rowtype;
  cap        constant integer  := 3;
  window_len constant interval := interval '12 hours';
begin
  if caller is null then
    return jsonb_build_object('ok', false, 'remaining', 0,
      'message', 'Sign in to send out a beacon.');
  end if;

  select * into q from public.beacon_quota where user_id = caller for update;

  if not found then
    insert into public.beacon_quota (user_id, used_in_window) values (caller, 1);
    return jsonb_build_object('ok', true, 'remaining', cap - 1,
      'resets_at', now() + window_len);
  end if;

  if q.window_start < now() - window_len then
    update public.beacon_quota
       set window_start = now(), used_in_window = 1
     where user_id = caller;
    return jsonb_build_object('ok', true, 'remaining', cap - 1,
      'resets_at', now() + window_len);
  end if;

  if q.used_in_window >= cap then
    return jsonb_build_object('ok', false, 'remaining', 0,
      'resets_at', q.window_start + window_len,
      'message', 'That is all three beacons for now. Fresh ones in a few hours — already-scanned ground stays free.');
  end if;

  update public.beacon_quota
     set used_in_window = q.used_in_window + 1
   where user_id = caller;

  return jsonb_build_object('ok', true,
    'remaining', cap - q.used_in_window - 1,
    'resets_at', q.window_start + window_len);
end;
$$;

grant execute on function public.claim_beacon_token() to authenticated;


-- ---------------------------------------------------------------------
--  9. READS
-- ---------------------------------------------------------------------

-- Positions projected server-side. PostgREST serves a geometry column as
-- EWKB hex, so a client that selected geom directly would get
-- '0101000020E6100000...' where it wanted two numbers — the same trap
-- migration 09 documents.
create or replace function public.beacon_spots_near(
  in_lat       double precision,
  in_lon       double precision,
  in_radius_km double precision default 25
)
returns table (
  id                uuid,
  latitude          double precision,
  longitude         double precision,
  tier              public.beacon_tier,
  generator         public.beacon_generator,
  label             text,
  land_basis        text,
  sign_evidence     text,
  verify_count      integer,
  rule_score        double precision,
  model_score       double precision,
  region            text,
  discovered_at     timestamptz,
  last_confirmed_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    s.id, st_y(s.geom), st_x(s.geom), s.tier, s.generator,
    s.label, s.land_basis, s.sign_evidence, s.verify_count,
    s.rule_score, s.model_score, s.region,
    s.discovered_at, s.last_confirmed_at
  from public.beacon_spots s
  where s.withdrawn_at is null
    and st_dwithin(
          s.geom::geography,
          st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography,
          least(coalesce(in_radius_km, 25), 200) * 1000
        )
  order by
    -- Evidence first, guesses last. Within a tier, best-scoring first.
    case s.tier when 'confirmed' then 0 when 'reported' then 1 else 2 end,
    (s.rule_score + s.model_score) desc,
    s.discovered_at desc
  limit 200;
$$;

grant execute on function public.beacon_spots_near(double precision, double precision, double precision)
  to anon, authenticated;

-- Has anyone swept this ground recently? 48 hours, as specified.
create or replace function public.beacon_scan_is_fresh(
  in_lat      double precision,
  in_lon      double precision,
  in_radius_m integer default 5000
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.beacon_scans sc
     where sc.scanned_at > now() - interval '48 hours'
       and sc.radius_m >= in_radius_m
       and st_dwithin(
             sc.geom::geography,
             st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography,
             greatest(sc.radius_m - in_radius_m, 0) + 250
           )
  );
$$;

grant execute on function public.beacon_scan_is_fresh(double precision, double precision, integer)
  to anon, authenticated;


-- ---------------------------------------------------------------------
--  10. PERSIST (server only)
--
--  Not granted to anon or authenticated. Scores are computed on the server
--  from data the server fetched; letting a browser post its own spots and
--  its own scores would make the whole ladder decorative.
-- ---------------------------------------------------------------------

create or replace function public.beacon_persist_spots(
  in_spots    jsonb,
  in_scan_lat double precision,
  in_scan_lon double precision,
  in_radius_m integer,
  in_sources  jsonb default '{}'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item    jsonb;
  tokens  text[];
  reg     text;
  written integer := 0;
  model   double precision;
begin
  for item in select * from jsonb_array_elements(coalesce(in_spots, '[]'::jsonb))
  loop
    tokens := coalesce(
      (select array_agg(value) from jsonb_array_elements_text(item -> 'tokens')),
      '{}'::text[]
    );

    -- Region key. Prefer the administrative area of whatever public land the
    -- point sits in, because that is the boundary regulations actually follow.
    -- Fall back to a 1-degree grid cell, which is always available and is a
    -- perfectly serviceable "roughly around here" for learning purposes.
    reg := coalesce(
      nullif(item ->> 'region', ''),
      (select pl.admin_area
         from public.public_lands pl
        where st_contains(pl.geom, st_setsrid(st_makepoint(
                (item ->> 'lon')::double precision,
                (item ->> 'lat')::double precision), 4326))
        limit 1),
      'grid:' || floor((item ->> 'lat')::double precision)::text
              || ',' || floor((item ->> 'lon')::double precision)::text
    );

    model := public.beacon_score(tokens, reg);

    insert into public.beacon_spots (
      geom, generator, label, land_basis, features, region,
      rule_score, model_score, sign_evidence
    )
    values (
      st_setsrid(st_makepoint((item ->> 'lon')::double precision,
                              (item ->> 'lat')::double precision), 4326),
      (item ->> 'generator')::public.beacon_generator,
      nullif(item ->> 'label', ''),
      nullif(item ->> 'land_basis', ''),
      jsonb_build_object('tokens', to_jsonb(tokens)),
      reg,
      coalesce((item ->> 'rule_score')::double precision, 0),
      model,
      coalesce(nullif(item ->> 'sign_evidence', ''), 'unknown')
    )
    on conflict (round(st_y(geom)::numeric, 5), round(st_x(geom)::numeric, 5))
    do update set
      -- Refresh the reasoning but never the tier. A spot campers have
      -- vouched for does not get demoted because a later scan saw less.
      label         = excluded.label,
      land_basis    = excluded.land_basis,
      features      = excluded.features,
      region        = excluded.region,
      rule_score    = excluded.rule_score,
      model_score   = excluded.model_score,
      sign_evidence = excluded.sign_evidence;

    written := written + 1;
  end loop;

  insert into public.beacon_scans (geom, radius_m, found_count, sources)
  values (
    st_setsrid(st_makepoint(in_scan_lon, in_scan_lat), 4326),
    in_radius_m, written, coalesce(in_sources, '{}'::jsonb)
  );

  return written;
end;
$$;

revoke all on function public.beacon_persist_spots(jsonb, double precision, double precision, integer, jsonb)
  from anon, authenticated;


-- ---------------------------------------------------------------------
--  11. PROOF OF PRESENCE
--
--  On spoofing: a browser has no mock-provider flag to read, so there is no
--  honest way to detect a faked position from the client. Everything real
--  happens here — implausible accuracy, impossible travel between pings, and
--  the byte-identical coordinate that no real GPS ever produces twice. These
--  raise the cost of faking a stay. They do not make it impossible, and
--  nothing in the UI claims they do.
-- ---------------------------------------------------------------------

create or replace function public.beacon_record_ping(
  in_spot     uuid,
  in_lat      double precision,
  in_lon      double precision,
  in_accuracy double precision default null,
  in_flags    jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller     uuid := auth.uid();
  spot       public.beacon_spots%rowtype;
  here       geometry;
  gap_m      double precision;
  prev       public.beacon_presence_pings%rowtype;
  seconds    double precision;
  kmh        double precision;
  first_at   timestamptz;
  dwell      integer;
  flags      jsonb := coalesce(in_flags, '{}'::jsonb);
begin
  if caller is null then
    return jsonb_build_object('ok', false, 'reason', 'signed_out',
      'message', 'Sign in to check in at a spot.');
  end if;

  select * into spot from public.beacon_spots where id = in_spot;
  if not found or spot.withdrawn_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'gone',
      'message', 'That spot is no longer on the map.');
  end if;

  if in_accuracy is not null and in_accuracy > 100 then
    return jsonb_build_object('ok', false, 'reason', 'accuracy',
      'accuracy_m', in_accuracy,
      'message', 'Your position is only accurate to ' || round(in_accuracy::numeric)
                 || ' m right now. Step somewhere with a clearer view of the sky.');
  end if;

  here  := st_setsrid(st_makepoint(in_lon, in_lat), 4326);
  gap_m := st_distance(here::geography, spot.geom::geography);

  if gap_m > 50 then
    return jsonb_build_object('ok', false, 'reason', 'outside',
      'distance_m', round(gap_m::numeric),
      'message', 'You are about ' || round(gap_m::numeric)
                 || ' m away. Check-in needs you within 50 m of the spot.');
  end if;

  select * into prev
    from public.beacon_presence_pings
   where user_id = caller
   order by at desc
   limit 1;

  if found then
    seconds := extract(epoch from (now() - prev.at));
    if seconds > 1 then
      kmh := (st_distance(here::geography, prev.geom::geography) / seconds) * 3.6;
      -- Faster than a light aircraft between two samples means one of them is
      -- not real. This one IS a rejection: nothing legitimate looks like it.
      if kmh > 400 then
        return jsonb_build_object('ok', false, 'reason', 'implausible',
          'message', 'That jump is too far, too fast to record. If your phone''s location is set to a fixed position, turn that off.');
      end if;
    end if;

    /*
     * An identical repeated coordinate is NOTED, never rejected.
     *
     * The first version of this function refused it as a spoofing tell, which
     * was exactly backwards. A camper parked for the night does not move, and
     * `watchPosition` only fires when the position CHANGES — so the honest,
     * stationary, four-hours-in-a-lay-by case is precisely the one that
     * re-sends the same fix. The check accused the population it exists to
     * serve, and a pinned location is genuinely indistinguishable from a van
     * that has not moved, so it never had any discriminating power to begin
     * with.
     *
     * The flag is kept because it is worth something in aggregate — a hundred
     * frozen pings across a dozen spots is a pattern — but it decides nothing
     * on its own. What actually resists faking is the geofence, the velocity
     * check above, the 200 km-in-4-hours rule in the verification, and the
     * photo.
     */
    if prev.spot_id = in_spot
       and st_x(prev.geom) = in_lon and st_y(prev.geom) = in_lat then
      flags := flags || jsonb_build_object('identical_to_previous', true);
    end if;
  end if;

  insert into public.beacon_presence_pings (user_id, spot_id, geom, accuracy_m, client_flags)
  values (caller, in_spot, here, in_accuracy, flags);

  -- Arrival is the earliest ping in this visit. A 36-hour lookback keeps a
  -- stay from being stitched together out of two different trips.
  select min(at) into first_at
    from public.beacon_presence_pings
   where user_id = caller and spot_id = in_spot
     and at > now() - interval '36 hours';

  dwell := greatest(0, (extract(epoch from (now() - first_at)) / 60)::integer);

  return jsonb_build_object(
    'ok', true,
    'distance_m', round(gap_m::numeric),
    'arrived_at', first_at,
    'dwell_minutes', dwell,
    'ready', dwell >= 240
  );
end;
$$;

grant execute on function public.beacon_record_ping(uuid, double precision, double precision, double precision, jsonb)
  to authenticated;


create or replace function public.beacon_submit_verification(
  in_spot       uuid,
  in_lat        double precision,
  in_lon        double precision,
  in_accuracy   double precision,
  in_photo_path text,
  in_answers    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller    uuid := auth.uid();
  ping      jsonb;
  spot      public.beacon_spots%rowtype;
  first_at  timestamptz;
  dwell     integer;
  restricted boolean;
  distinct_verifiers integer;
  far_away  integer;
begin
  if caller is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to vouch for a spot.');
  end if;

  if in_photo_path is null or in_photo_path = '' then
    return jsonb_build_object('ok', false,
      'message', 'A photo of the spot is required. It is the part nobody can fake from the couch.');
  end if;

  -- The submission itself is a ping, and it goes through every one of the
  -- same checks.
  ping := public.beacon_record_ping(in_spot, in_lat, in_lon, in_accuracy,
                                    jsonb_build_object('submission', true));
  if not (ping ->> 'ok')::boolean then
    return jsonb_build_object('ok', false, 'message', ping ->> 'message', 'detail', ping);
  end if;

  select * into spot from public.beacon_spots where id = in_spot;

  select min(at) into first_at
    from public.beacon_presence_pings
   where user_id = caller and spot_id = in_spot
     and at > now() - interval '36 hours';

  dwell := greatest(0, (extract(epoch from (now() - first_at)) / 60)::integer);

  if dwell < 240 then
    insert into public.beacon_verifications
      (spot_id, user_id, arrived_at, dwell_minutes, photo_path, answers, accepted, reject_reason)
    values (in_spot, caller, first_at, dwell, in_photo_path, coalesce(in_answers, '{}'::jsonb),
            false, 'dwell_short');
    return jsonb_build_object('ok', false, 'dwell_minutes', dwell,
      'message', 'You have been here ' || dwell || ' minutes. Vouching for a spot takes four hours — check back in later and it will count.');
  end if;

  -- Two accounts on the same account cannot both vouch. The unique index
  -- enforces it, but catching it here gives the camper a sentence instead of
  -- a constraint violation.
  if exists (select 1 from public.beacon_verifications
              where spot_id = in_spot and user_id = caller and accepted) then
    return jsonb_build_object('ok', false,
      'message', 'You have already vouched for this spot. It needs a different camper now.');
  end if;

  -- Same account, two spots 200 km apart inside the dwell window. One of
  -- those stays did not happen.
  select count(*) into far_away
    from public.beacon_verifications v
    join public.beacon_spots s2 on s2.id = v.spot_id
   where v.user_id = caller
     and v.accepted
     and v.submitted_at > now() - interval '4 hours'
     and st_distance(s2.geom::geography, spot.geom::geography) > 200000;

  if far_away > 0 then
    insert into public.beacon_verifications
      (spot_id, user_id, arrived_at, dwell_minutes, photo_path, answers, accepted, reject_reason)
    values (in_spot, caller, first_at, dwell, in_photo_path, coalesce(in_answers, '{}'::jsonb),
            false, 'impossible_trip');
    return jsonb_build_object('ok', false,
      'message', 'You vouched for a spot hundreds of kilometres from here a few hours ago. This one is on hold for review.');
  end if;

  restricted := coalesce((in_answers ->> 'signs_restricted')::boolean, false);

  -- The camper is standing in front of the sign. Their answer beats anything
  -- an algorithm inferred from map tags, so it takes the spot down and
  -- teaches the model that whatever produced it was wrong.
  if restricted then
    insert into public.beacon_verifications
      (spot_id, user_id, arrived_at, dwell_minutes, photo_path, answers, accepted, reject_reason)
    values (in_spot, caller, first_at, dwell, in_photo_path, in_answers, false, 'signs_restricted');

    insert into public.beacon_reports (spot_id, user_id, outcome, detail)
    values (in_spot, caller, 'posted_no_parking', nullif(in_answers ->> 'note', ''));

    update public.beacon_spots
       set tier = 'withdrawn', withdrawn_at = now(),
           withdrawn_reason = 'A camper found restricted parking signs here.'
     where id = in_spot;

    perform public.grant_points(caller, 8, 'beacon_takedown'::public.points_reason,
      'beacon_spots', in_spot::text, 'Reported restricted signage at a beacon spot');

    return jsonb_build_object('ok', true, 'accepted', false, 'withdrawn', true,
      'message', 'Thank you — that spot is off the map now, and the app just learned something from it.');
  end if;

  insert into public.beacon_verifications
    (spot_id, user_id, arrived_at, dwell_minutes, photo_path, answers, accepted)
  values (in_spot, caller, first_at, dwell, in_photo_path, coalesce(in_answers, '{}'::jsonb), true);

  select count(distinct user_id) into distinct_verifiers
    from public.beacon_verifications
   where spot_id = in_spot and accepted;

  -- The ladder. One camper makes it 'reported'; it takes separate accounts
  -- to reach 'confirmed', and no algorithm can do either.
  update public.beacon_spots
     set verify_count      = distinct_verifiers,
         last_confirmed_at = now(),
         tier = case when distinct_verifiers >= 2 then 'confirmed'::public.beacon_tier
                     else 'reported'::public.beacon_tier end
   where id = in_spot;

  perform public.grant_points(caller, 15, 'beacon_verify'::public.points_reason,
    'beacon_spots', in_spot::text, 'Vouched for a beacon spot after a four-hour stay');

  return jsonb_build_object(
    'ok', true, 'accepted', true,
    'dwell_minutes', dwell,
    'verifiers', distinct_verifiers,
    'tier', case when distinct_verifiers >= 2 then 'confirmed' else 'reported' end,
    'message', case when distinct_verifiers >= 2
                    then 'Confirmed. Other campers have vouched for this one too.'
                    else 'Logged. This spot now says one camper has actually slept here.' end
  );
end;
$$;

grant execute on function public.beacon_submit_verification(uuid, double precision, double precision, double precision, text, jsonb)
  to authenticated;


-- ---------------------------------------------------------------------
--  12. TAKEDOWN
--
--  Instant and unconditional. One report pulls the spot off the map. The
--  false-positive cost is a camper missing one possible place to sleep; the
--  false-negative cost is a camper getting a ticket or a knock on the window
--  at 3am. Those are not close.
-- ---------------------------------------------------------------------

create or replace function public.beacon_report_spot(
  in_spot    uuid,
  in_outcome public.beacon_outcome,
  in_detail  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare caller uuid := auth.uid();
begin
  if caller is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to report a spot.');
  end if;

  if not exists (select 1 from public.beacon_spots where id = in_spot) then
    return jsonb_build_object('ok', false, 'message', 'That spot is no longer on the map.');
  end if;

  insert into public.beacon_reports (spot_id, user_id, outcome, detail)
  values (in_spot, caller, in_outcome, nullif(in_detail, ''));

  if in_outcome = 'good' then
    return jsonb_build_object('ok', true, 'withdrawn', false,
      'message', 'Noted — thanks for saying so.');
  end if;

  update public.beacon_spots
     set tier = 'withdrawn',
         withdrawn_at = now(),
         withdrawn_reason = case in_outcome
           when 'ticketed'          then 'A camper was ticketed here.'
           when 'asked_to_leave'    then 'A camper was asked to leave here.'
           when 'posted_no_parking' then 'A camper found restricted parking signs here.'
           else 'A camper found this spot no longer usable.'
         end
   where id = in_spot;

  perform public.grant_points(caller, 8, 'beacon_takedown'::public.points_reason,
    'beacon_spots', in_spot::text, 'Reported a bad beacon spot');

  return jsonb_build_object('ok', true, 'withdrawn', true,
    'message', 'Off the map, and the app learned from it. Sorry that happened.');
end;
$$;

grant execute on function public.beacon_report_spot(uuid, public.beacon_outcome, text)
  to authenticated;


-- ---------------------------------------------------------------------
--  13. DECAY AND MAINTENANCE
-- ---------------------------------------------------------------------

-- Six months with nobody checking in and a 'confirmed' spot drops back to
-- 'reported'. Land use changes, signs go up, gates get locked. Confidence
-- should have a shelf life.
create or replace function public.beacon_decay()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare moved integer;
begin
  update public.beacon_spots
     set tier = 'reported'
   where tier = 'confirmed'
     and withdrawn_at is null
     and coalesce(last_confirmed_at, discovered_at) < now() - interval '6 months';
  get diagnostics moved = row_count;
  return moved;
end;
$$;

create or replace function public.beacon_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  decayed integer;
  tokens  integer;
  scans   integer;
  pings   integer;
begin
  decayed := public.beacon_decay();
  tokens  := public.beacon_relearn();

  -- The scan cache only claims to answer "was this swept in the last 48
  -- hours". A week is plenty of history for that.
  delete from public.beacon_scans where scanned_at < now() - interval '7 days';
  get diagnostics scans = row_count;

  -- Pings are a means to an end. Once the verification exists, the raw
  -- location trail has served its purpose and keeping it is just a privacy
  -- liability. Migration 02 makes the same argument about presence.
  delete from public.beacon_presence_pings where at < now() - interval '30 days';
  get diagnostics pings = row_count;

  return jsonb_build_object(
    'decayed', decayed, 'token_rows', tokens,
    'scans_purged', scans, 'pings_purged', pings, 'ran_at', now()
  );
end;
$$;

comment on function public.beacon_maintenance() is
  'Nightly housekeeping: decay stale confirmations, rebuild the model, purge the scan cache and old location pings.';


-- ---------------------------------------------------------------------
--  14. POINTS RULES
-- ---------------------------------------------------------------------

insert into public.points_rules (reason, amount, daily_cap, description)
values
  ('beacon_verify',   15, 2, 'Vouched for a beacon spot after a four-hour stay'),
  ('beacon_takedown',  8, 5, 'Reported a beacon spot that turned out to be bad')
on conflict (reason) do update
  set amount = excluded.amount,
      daily_cap = excluded.daily_cap,
      description = excluded.description;


-- ---------------------------------------------------------------------
--  15. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------

alter table public.beacon_spots           enable row level security;
alter table public.beacon_scans           enable row level security;
alter table public.beacon_quota           enable row level security;
alter table public.beacon_presence_pings  enable row level security;
alter table public.beacon_verifications   enable row level security;
alter table public.beacon_reports         enable row level security;
alter table public.beacon_signals         enable row level security;

do $$ begin
  -- Spots are readable by anyone. They are the feature.
  create policy "read: live beacon spots" on public.beacon_spots
    for select using (withdrawn_at is null);
exception when duplicate_object then null; end $$;

do $$ begin
  -- The model is public on purpose. A ranking nobody can inspect is a
  -- ranking nobody should trust.
  create policy "read: beacon signals" on public.beacon_signals
    for select using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "read: own beacon quota" on public.beacon_quota
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "read: own beacon pings" on public.beacon_presence_pings
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "read: own beacon verifications" on public.beacon_verifications
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "read: own beacon reports" on public.beacon_reports
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- beacon_scans gets no policy at all: RLS is on and nothing is permitted, so
-- only the SECURITY DEFINER functions and the service role can touch it.

-- Writes everywhere else go through the definer functions above. No table
-- here has an insert or update policy, deliberately.

grant select on public.beacon_spots, public.beacon_signals to anon, authenticated;
grant select on public.beacon_quota, public.beacon_presence_pings,
                public.beacon_verifications, public.beacon_reports to authenticated;

commit;


-- ---------------------------------------------------------------------
--  16. STORAGE FOR PROOF PHOTOS
--
--  Private bucket, foldered by user id. The photo is evidence, not content:
--  nobody browses these, and a camper's own folder is the only thing they
--  can read.
-- ---------------------------------------------------------------------

--  storage.objects is owned by supabase_storage_admin, so policy creation can
--  be refused depending on who runs this. Guarded rather than fatal: without
--  the bucket, verification tells the camper the photo could not be stored
--  instead of the migration refusing to install.

do $$
begin
  insert into storage.buckets (id, name, public)
  values ('beacon-proof', 'beacon-proof', false)
  on conflict (id) do nothing;
exception when others then
  raise notice 'Could not create the beacon-proof bucket (%).', sqlerrm;
end $$;

do $$ begin
  create policy "insert: own beacon proof" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'beacon-proof'
                and (storage.foldername(name))[1] = auth.uid()::text);
exception
  when duplicate_object then null;
  when others then raise notice 'Could not add the beacon proof insert policy (%).', sqlerrm;
end $$;

do $$ begin
  create policy "read: own beacon proof" on storage.objects
    for select to authenticated
    using (bucket_id = 'beacon-proof'
           and (storage.foldername(name))[1] = auth.uid()::text);
exception
  when duplicate_object then null;
  when others then raise notice 'Could not add the beacon proof read policy (%).', sqlerrm;
end $$;


-- ---------------------------------------------------------------------
--  17. NIGHTLY SCHEDULE
--
--  pg_cron runs entirely inside Postgres — no network, no secret, nothing to
--  configure anywhere else. If the extension is not available the migration
--  still succeeds and beacon_maintenance() can be called by hand; the
--  feature degrades to "the model updates when someone asks it to" rather
--  than failing to install.
-- ---------------------------------------------------------------------

do $$
begin
  create extension if not exists pg_cron;

  begin
    perform cron.unschedule('beacon-maintenance');
  exception when others then null;
  end;

  perform cron.schedule('beacon-maintenance', '17 4 * * *',
                        'select public.beacon_maintenance();');
exception when others then
  raise notice 'pg_cron unavailable (%). beacon_maintenance() must be called manually.', sqlerrm;
end $$;
