-- ---------------------------------------------------------------------
--  MIGRATION 14 — SPOT REPORTS, THE FOUR-RUNG LADDER, AND THE KNOCK
--
--  Run after 13. Safe to re-run.
--
--  Three things change here.
--
--  ONE: A CAMPER CAN NOW REPORT ON A SPOT WITHOUT SITTING THERE FOR FOUR
--  HOURS. Migration 13 had exactly one way to move a spot up the ladder —
--  a four-hour dwell — which meant somebody who pulled in at noon, looked
--  around and drove on had no way to tell anyone what they saw. That is most
--  of the useful traffic, thrown away. `beacon_submit_visit` accepts a report
--  backed by a photo and a position, and records whether an overnight dwell
--  was behind it. Both count; they are not pretended to be the same thing.
--
--  TWO: THE LADDER GAINS A RUNG AND ALL FOUR THRESHOLDS MOVE INTO ONE
--  FUNCTION. `beacon_tier_for()` is the only place a camper count becomes a
--  tier. The client mirrors these numbers in BEACON_TIER_STEPS purely so it
--  can say "one more camper turns this green"; this function decides.
--
--  THREE: A KNOCK NO LONGER DELETES THE SPOT. Migration 13 pulled a spot off
--  the map the moment anybody was moved on. The reasoning was sound and the
--  effect was not: the pullout is still there, the next camper finds it on
--  their own, parks, and gets the same knock at 3am — with the app having
--  known and said nothing. A knock now turns the spot RED and leaves it
--  visible, carrying the reporter's own words. `withdrawn` is kept for the
--  one case where vanishing is right: the place is gated, built on, or
--  otherwise no longer a place.
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
--  0. NEW ENUM VALUES
--
--  Postgres will not let a new enum value be USED in the transaction that
--  created it, so these run on their own, before the main transaction.
-- ---------------------------------------------------------------------

alter type public.beacon_tier add value if not exists 'corroborated' after 'reported';
alter type public.beacon_tier add value if not exists 'flagged';

-- Spots a camper created themselves, as opposed to ones the scan found.
alter type public.beacon_generator add value if not exists 'camper';

alter type public.points_reason add value if not exists 'spot_report';


begin;

-- ---------------------------------------------------------------------
--  1. THE LADDER, IN ONE PLACE
--
--  Thresholds deliberately low: 1 / 2 / 4. A ladder whose top rung needs
--  five separate campers is a ladder nothing climbs while the app is young,
--  and a colour nobody ever sees teaches nobody anything. Retune here and
--  in BEACON_TIER_STEPS on the client, together.
-- ---------------------------------------------------------------------

create or replace function public.beacon_tier_for(
  in_verify_count integer,
  in_knock_count  integer default 0
)
returns public.beacon_tier
language sql
immutable
as $$
  select case
    -- A knock outranks every amount of good news. Four campers may have slept
    -- soundly here; the fifth was woken by an officer, and that is the fact
    -- the next camper needs first.
    when coalesce(in_knock_count, 0) > 0 then 'flagged'::public.beacon_tier
    when coalesce(in_verify_count, 0) >= 4 then 'confirmed'::public.beacon_tier
    when coalesce(in_verify_count, 0) >= 2 then 'corroborated'::public.beacon_tier
    when coalesce(in_verify_count, 0) >= 1 then 'reported'::public.beacon_tier
    else 'lead'::public.beacon_tier
  end;
$$;

comment on function public.beacon_tier_for(integer, integer) is
  'The only place a camper count becomes a tier. 1 = reported, 2 = corroborated, 4 = confirmed; any knock = flagged, which outranks all of them.';


-- ---------------------------------------------------------------------
--  2. AGGREGATE COLUMNS ON THE SPOT
--
--  Denormalised on purpose. `beacon_spots_near` returns up to 200 rows and
--  is called on every meaningful map pan; averaging a join across every
--  visit each time would make the map layer the slowest thing in the app.
--  These are recomputed by beacon_refresh_spot_stats() after each write,
--  which is the only place they are ever set.
--
--  Every average is NULLABLE and null means NOBODY ANSWERED. It does not
--  mean zero, and nothing downstream may render it as one.
-- ---------------------------------------------------------------------

alter table public.beacon_spots
  add column if not exists visit_count       integer not null default 0,
  add column if not exists knock_count       integer not null default 0,
  add column if not exists last_knock_at     timestamptz,
  add column if not exists last_knock_note   text,
  add column if not exists avg_crowding      double precision,
  add column if not exists avg_rating        double precision,
  add column if not exists avg_view          double precision,
  add column if not exists avg_max_rig       double precision,
  add column if not exists avg_road_access   double precision,
  add column if not exists avg_level_ground  double precision,
  add column if not exists avg_shade         double precision,
  add column if not exists avg_night_light   double precision,
  add column if not exists avg_cell_bars     double precision,
  add column if not exists photo_paths       text[] not null default '{}';

comment on column public.beacon_spots.knock_count is
  'Separate campers who reported being woken or moved on. Any value above zero forces the flagged tier and keeps the pin red AND visible.';


-- ---------------------------------------------------------------------
--  3. VISITS
--
--  One row per camper per spot per report. Distinct from
--  beacon_verifications, which stays as it was and means specifically "a
--  four-hour dwell was proved". A visit may or may not have one behind it,
--  and `stayed_overnight` records which.
-- ---------------------------------------------------------------------

create table if not exists public.beacon_visits (
  id            uuid primary key default gen_random_uuid(),
  spot_id       uuid not null references public.beacon_spots(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,

  -- The scales. All nullable, all meaning "not answered" when null. The
  -- ranges match SPOT_SCALE_FIELDS in src/config/spotReport.ts.
  crowding      smallint check (crowding     between 0 and 4),
  rating        smallint check (rating       between 0 and 4),
  view_rating   smallint check (view_rating  between 0 and 4),
  max_rig       smallint check (max_rig      between 0 and 4),
  road_access   smallint check (road_access  between 0 and 3),
  level_ground  smallint check (level_ground between 0 and 2),
  shade         smallint check (shade        between 0 and 2),
  night_light   smallint check (night_light  between 0 and 3),

  -- Tri-state. Null means we never asked, which is what happens whenever the
  -- POI sweep already found one within 5 km.
  has_shower    boolean,
  has_restroom  boolean,
  has_fuel      boolean,

  got_knocked      boolean not null default false,
  comment          text,
  photo_paths      text[] not null default '{}',
  stayed_overnight boolean not null default false,

  cell_bars     smallint check (cell_bars between 0 and 5),
  cell_carrier  text,

  -- Where the camper actually was when they submitted. Kept for the
  -- anti-spoof checks and NEVER returned to another camper — the published
  -- position is the spot's, not the reporter's.
  geom          geometry(Point, 4326),
  accuracy_m    double precision,
  client_flags  jsonb not null default '{}'::jsonb,

  accepted      boolean not null default false,
  reject_reason text,
  created_at    timestamptz not null default now()
);

create index if not exists beacon_visits_spot_idx
  on public.beacon_visits (spot_id, created_at desc) where accepted;
create index if not exists beacon_visits_user_idx
  on public.beacon_visits (user_id, created_at desc);

-- One accepted report per camper per spot. Without this a single person walks
-- a lead to green on their own, which is the exact thing the ladder exists to
-- prevent. A camper who wants to update their report replaces it — see
-- beacon_submit_visit, which deletes the previous one inside the same call.
create unique index if not exists beacon_visits_one_per_user_idx
  on public.beacon_visits (spot_id, user_id) where accepted;

comment on table public.beacon_visits is
  'What a camper said about a spot after being there. Every scale is nullable and null means not answered, never zero.';


-- ---------------------------------------------------------------------
--  4. RECOMPUTE
--
--  The single writer for every aggregate column and for the tier. Called
--  after any visit or report. Cheap: one pass over one spot's visits.
-- ---------------------------------------------------------------------

create or replace function public.beacon_refresh_spot_stats(in_spot uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  verifiers integer;
  knocks    integer;
begin
  /**
   * Distinct CAMPERS, not distinct reports — counting rows would let one
   * account climb the ladder by submitting repeatedly.
   *
   * And only reports that came with a photo. `beacon_report_spot` writes a
   * visit row with no photo and no position check, because somebody woken at
   * 3am should not have to prove anything to file a warning. That is right for
   * a warning and wrong for a rung: without this filter, a takedown would
   * quietly push the spot UP the ladder at the same moment it turned it red.
   */
  select count(distinct user_id) into verifiers
    from public.beacon_visits
   where spot_id = in_spot and accepted
     and array_length(photo_paths, 1) is not null;

  select count(distinct user_id) into knocks
    from public.beacon_visits
   where spot_id = in_spot and accepted and got_knocked;

  -- A four-hour dwell from migration 13 still counts toward the ladder. The
  -- two paths are different strengths of evidence, not different currencies.
  verifiers := verifiers + coalesce((
    select count(distinct v.user_id)
      from public.beacon_verifications v
     where v.spot_id = in_spot
       and v.accepted
       and not exists (
         select 1 from public.beacon_visits bv
          where bv.spot_id = in_spot and bv.user_id = v.user_id and bv.accepted
       )
  ), 0);

  update public.beacon_spots s
     -- Same filter as `verifiers`: this number is shown to campers as "what N
     -- campers said", and a photo-less takedown row contributed no answers to
     -- say. Counting it would overstate the sample behind every average below.
     set visit_count      = (select count(*) from public.beacon_visits
                              where spot_id = in_spot and accepted
                                and array_length(photo_paths, 1) is not null),
         verify_count     = verifiers,
         knock_count      = knocks,
         -- avg() over a column that is null everywhere returns null, which is
         -- exactly the wanted answer: nobody said.
         avg_crowding     = (select avg(crowding)     from public.beacon_visits where spot_id = in_spot and accepted),
         avg_rating       = (select avg(rating)       from public.beacon_visits where spot_id = in_spot and accepted),
         avg_view         = (select avg(view_rating)  from public.beacon_visits where spot_id = in_spot and accepted),
         avg_max_rig      = (select avg(max_rig)      from public.beacon_visits where spot_id = in_spot and accepted),
         avg_road_access  = (select avg(road_access)  from public.beacon_visits where spot_id = in_spot and accepted),
         avg_level_ground = (select avg(level_ground) from public.beacon_visits where spot_id = in_spot and accepted),
         avg_shade        = (select avg(shade)        from public.beacon_visits where spot_id = in_spot and accepted),
         avg_night_light  = (select avg(night_light)  from public.beacon_visits where spot_id = in_spot and accepted),
         avg_cell_bars    = (select avg(cell_bars)    from public.beacon_visits where spot_id = in_spot and accepted),
         last_knock_at    = (select max(created_at) from public.beacon_visits
                              where spot_id = in_spot and accepted and got_knocked),
         last_knock_note  = (select comment from public.beacon_visits
                              where spot_id = in_spot and accepted and got_knocked
                                and comment is not null and comment <> ''
                              order by created_at desc limit 1),
         -- `bv.photo_paths` is qualified deliberately: this sits inside an
         -- UPDATE on beacon_spots, which has a column of the same name, and an
         -- unqualified reference here is the kind of thing that resolves the
         -- way you wanted right up until somebody reorders the query.
         photo_paths      = coalesce((
                              select array_agg(p order by p)
                                from (
                                  select distinct unnest(bv.photo_paths) as p
                                    from public.beacon_visits bv
                                   where bv.spot_id = in_spot and bv.accepted
                                   limit 12
                                ) q
                            ), '{}'),
         last_confirmed_at = greatest(
                              s.last_confirmed_at,
                              (select max(created_at) from public.beacon_visits
                                where spot_id = in_spot and accepted)
                            ),
         -- A spot that is genuinely gone stays gone. Everything else is the
         -- ladder's business.
         tier = case when s.withdrawn_at is not null
                     then 'withdrawn'::public.beacon_tier
                     else public.beacon_tier_for(verifiers, knocks) end
   where s.id = in_spot;
end;
$$;


-- ---------------------------------------------------------------------
--  5. SUBMIT A VISIT
--
--  ---------------------------------------------------------------------
--  WHAT THIS CAN AND CANNOT PROVE ABOUT SOMEBODY BEING THERE
--  ---------------------------------------------------------------------
--
--  It cannot prove it. There is no mock-location flag in the web platform,
--  and every signal a browser can send is editable by whoever is faking it.
--  What this does is make casual spoofing inconvenient and leave a trail:
--
--    - the submitted position must be within 150 m of the spot
--    - a photo path is required, and the bucket only accepts writes into the
--      caller's own folder
--    - one accepted report per camper per spot
--    - a report from an account that reported somewhere 200 km away in the
--      last four hours is held rather than accepted
--    - a report from an account whose last report was under two minutes ago
--      is held; a human filling this in honestly takes longer than that
--
--  None of that is airtight and the UI never claims it is. The tier labels
--  say how many campers said something, not that they were telling the truth.
-- ---------------------------------------------------------------------

create or replace function public.beacon_submit_visit(
  in_spot     uuid,
  in_lat      double precision,
  in_lon      double precision,
  in_accuracy double precision default null,
  in_report   jsonb default '{}'::jsonb,
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
  here       geometry(Point, 4326);
  distance_m double precision;
  far_away   integer;
  too_soon   boolean;
  knocked    boolean := coalesce((in_report ->> 'gotKnocked')::boolean, false);
  photos     text[] := coalesce(
                 (select array_agg(value::text)
                    from jsonb_array_elements_text(
                      case when jsonb_typeof(in_report -> 'photoPaths') = 'array'
                           then in_report -> 'photoPaths' else '[]'::jsonb end
                    ) as value),
                 '{}'::text[]);
  new_tier   public.beacon_tier;
  verifiers  integer;
begin
  if caller is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to report on a spot.');
  end if;

  select * into spot from public.beacon_spots where id = in_spot;
  if not found then
    return jsonb_build_object('ok', false, 'message', 'That spot is no longer on the map.');
  end if;

  if array_length(photos, 1) is null then
    return jsonb_build_object('ok', false,
      'message', 'A photo taken here is required — it is the part nobody can fake from the couch.');
  end if;

  here := st_setsrid(st_makepoint(in_lon, in_lat), 4326);
  distance_m := st_distance(here::geography, spot.geom::geography);

  -- 150 m rather than the dwell check's 50 m. A camper submitting on the spot
  -- may be standing at the far end of a big pullout with a poor fix, and
  -- rejecting an honest report over GPS drift trains people not to bother.
  if distance_m > 150 then
    return jsonb_build_object('ok', false,
      'distance_m', round(distance_m),
      'message', 'You need to be at the spot to report on it. You are ' ||
                 round(distance_m) || ' m away.');
  end if;

  select exists (
    select 1 from public.beacon_visits
     where user_id = caller and created_at > now() - interval '2 minutes'
  ) into too_soon;

  if too_soon then
    return jsonb_build_object('ok', false,
      'message', 'Give it a minute between reports.');
  end if;

  select count(*) into far_away
    from public.beacon_visits v
    join public.beacon_spots s2 on s2.id = v.spot_id
   where v.user_id = caller
     and v.accepted
     and v.created_at > now() - interval '4 hours'
     and st_distance(s2.geom::geography, spot.geom::geography) > 200000;

  if far_away > 0 then
    insert into public.beacon_visits
      (spot_id, user_id, geom, accuracy_m, client_flags, accepted, reject_reason,
       comment, photo_paths)
    values (in_spot, caller, here, in_accuracy, coalesce(in_flags, '{}'::jsonb),
            false, 'impossible_trip',
            nullif(in_report ->> 'comment', ''), photos);

    return jsonb_build_object('ok', false,
      'message', 'You reported on a spot hundreds of kilometres from here a few hours ago. This one is on hold for review.');
  end if;

  -- Replacing your own earlier report rather than stacking a second one. The
  -- unique index would reject the insert; deleting first is what makes
  -- "I came back and it was busier this time" possible.
  delete from public.beacon_visits
   where spot_id = in_spot and user_id = caller and accepted;

  insert into public.beacon_visits (
    spot_id, user_id,
    crowding, rating, view_rating, max_rig, road_access,
    level_ground, shade, night_light,
    has_shower, has_restroom, has_fuel,
    got_knocked, comment, photo_paths, stayed_overnight,
    cell_bars, cell_carrier,
    geom, accuracy_m, client_flags, accepted
  ) values (
    in_spot, caller,
    (in_report ->> 'crowding')::smallint,
    (in_report ->> 'rating')::smallint,
    (in_report ->> 'view')::smallint,
    (in_report ->> 'maxRig')::smallint,
    (in_report ->> 'roadAccess')::smallint,
    (in_report ->> 'levelGround')::smallint,
    (in_report ->> 'shade')::smallint,
    (in_report ->> 'nightLight')::smallint,
    (in_report ->> 'hasShower')::boolean,
    (in_report ->> 'hasRestroom')::boolean,
    (in_report ->> 'hasFuel')::boolean,
    knocked,
    nullif(in_report ->> 'comment', ''),
    photos,
    coalesce((in_report ->> 'stayedOvernight')::boolean, false),
    (in_report ->> 'cellBars')::smallint,
    nullif(in_report ->> 'cellCarrier', ''),
    here, in_accuracy, coalesce(in_flags, '{}'::jsonb), true
  );

  -- A knock is also a report in its own right, so the model learns from it
  -- the same way it learns from a takedown.
  if knocked then
    insert into public.beacon_reports (spot_id, user_id, outcome, detail)
    values (in_spot, caller, 'asked_to_leave', nullif(in_report ->> 'comment', ''));
  end if;

  perform public.beacon_refresh_spot_stats(in_spot);

  select tier, verify_count into new_tier, verifiers
    from public.beacon_spots where id = in_spot;

  perform public.grant_points(
    caller,
    case when knocked then 12 else 10 end,
    'spot_report'::public.points_reason,
    'beacon_spots', in_spot::text,
    'Reported on a camping spot');

  return jsonb_build_object(
    'ok', true,
    'tier', new_tier,
    'verifiers', verifiers,
    -- Keyed off the camper COUNT, not just the resulting tier. Keying it off
    -- the tier told the third and fourth campers "a second camper agreeing is
    -- what moves this up", which is both wrong and faintly insulting to
    -- somebody who just drove out there.
    'message', case
      when knocked then 'Logged, and this spot is red for everyone now. Thank you — that warning is worth a lot to the next camper.'
      when verifiers >= 4 then 'Logged. Enough campers have now reported on this one that it shows green.'
      when verifiers = 3 then 'Logged. One more camper and this one turns green.'
      when verifiers = 2 then 'Logged. A second camper agreeing is what moves this one up.'
      else 'Logged. This spot now says a camper has actually been here.'
    end
  );
end;
$$;

grant execute on function public.beacon_submit_visit(uuid, double precision, double precision, double precision, jsonb, jsonb)
  to authenticated;


-- ---------------------------------------------------------------------
--  6. CREATE A SPOT AS A CAMPER
--
--  The other half of the submission flow: somebody parked somewhere the scan
--  never found. The spot is created at 'lead' and the caller's own report is
--  applied immediately, which lands it on 'reported' — one camper, which is
--  exactly what it is.
--
--  The label is passed in, but see server/spotContext.ts: the client builds
--  it from OpenStreetMap rather than letting anybody type one. This function
--  still trims and length-caps it, because a function that trusts its caller
--  to have done that is a function that eventually meets a caller that did not.
-- ---------------------------------------------------------------------

create or replace function public.beacon_create_spot(
  in_lat      double precision,
  in_lon      double precision,
  in_label    text,
  in_basis    text default null,
  in_accuracy double precision default null,
  in_report   jsonb default '{}'::jsonb,
  in_flags    jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller   uuid := auth.uid();
  existing uuid;
  new_id   uuid;
  label    text := nullif(btrim(coalesce(in_label, '')), '');
  recent   integer;
  outcome  jsonb;
begin
  if caller is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to add a spot.');
  end if;

  if in_lat is null or in_lon is null
     or in_lat < -90 or in_lat > 90 or in_lon < -180 or in_lon > 180 then
    return jsonb_build_object('ok', false, 'message', 'That is not a position on Earth.');
  end if;

  -- Six new spots a day from one account is already generous for somebody
  -- genuinely travelling. Beyond that it is somebody drawing on the map.
  select count(*) into recent
    from public.beacon_spots
   where generator = 'camper'
     and discovered_at > now() - interval '24 hours'
     and id in (select spot_id from public.beacon_visits where user_id = caller);

  if recent >= 6 then
    return jsonb_build_object('ok', false,
      'message', 'That is six new spots today. Come back tomorrow.');
  end if;

  -- Somebody else's pin 40 m away is the same pullout. Reporting on it beats
  -- stacking a second pin on top, and the dedupe index would reject the
  -- insert anyway once they are within a metre of each other.
  select id into existing
    from public.beacon_spots
   where st_dwithin(geom::geography,
                    st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography, 40)
     and withdrawn_at is null
   order by st_distance(geom::geography,
                        st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography)
   limit 1;

  if existing is not null then
    return public.beacon_submit_visit(existing, in_lat, in_lon, in_accuracy, in_report, in_flags)
           || jsonb_build_object('spot_id', existing, 'merged', true);
  end if;

  insert into public.beacon_spots (
    geom, tier, generator, label, land_basis, sign_evidence,
    rule_score, region, features
  ) values (
    st_setsrid(st_makepoint(in_lon, in_lat), 4326),
    'lead', 'camper',
    left(coalesce(label, 'Camper spot'), 80),
    left(nullif(btrim(coalesce(in_basis, '')), ''), 240),
    -- A camper standing there has not checked street-level imagery, and this
    -- column means specifically what the SIGN SWEEP found. Unknown is honest.
    'unknown',
    0,
    coalesce((select region from public.beacon_spots
               order by geom <-> st_setsrid(st_makepoint(in_lon, in_lat), 4326)
               limit 1), '*'),
    jsonb_build_object('tokens', jsonb_build_array('source=camper'))
  )
  returning id into new_id;

  outcome := public.beacon_submit_visit(new_id, in_lat, in_lon, in_accuracy, in_report, in_flags);

  /**
   * If the report was refused, the spot must not survive it.
   *
   * Without this, a rejected submission — too far away, no photo, one report
   * too soon after the last — left a brand-new pin sitting on the map at
   * 'lead' with nothing behind it: a spot nobody had visited, that the scan
   * had never found, that existed only because somebody's submission failed.
   * The camper gets an error and a phantom pin appears anyway, which is the
   * worst of both outcomes.
   */
  if not coalesce((outcome ->> 'ok')::boolean, false) then
    delete from public.beacon_spots where id = new_id;
    return outcome;
  end if;

  return outcome || jsonb_build_object('spot_id', new_id, 'merged', false);
end;
$$;

grant execute on function public.beacon_create_spot(double precision, double precision, text, text, double precision, jsonb, jsonb)
  to authenticated;


-- ---------------------------------------------------------------------
--  7. READS, WITH THE NEW COLUMNS
--
--  Replaces the migration 13 version. Note what is NOT filtered out any more:
--  flagged spots. They are the whole point of the change — a red pin with a
--  camper's warning on it is more use than a pin that quietly vanished.
-- ---------------------------------------------------------------------

drop function if exists public.beacon_spots_near(double precision, double precision, double precision);

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
  visit_count       integer,
  knock_count       integer,
  last_knock_at     timestamptz,
  last_knock_note   text,
  avg_crowding      double precision,
  avg_rating        double precision,
  avg_view          double precision,
  avg_max_rig       double precision,
  avg_road_access   double precision,
  avg_level_ground  double precision,
  avg_shade         double precision,
  avg_night_light   double precision,
  avg_cell_bars     double precision,
  photo_paths       text[],
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
    s.label, s.land_basis, s.sign_evidence,
    s.verify_count, s.visit_count, s.knock_count, s.last_knock_at, s.last_knock_note,
    s.avg_crowding, s.avg_rating, s.avg_view, s.avg_max_rig, s.avg_road_access,
    s.avg_level_ground, s.avg_shade, s.avg_night_light, s.avg_cell_bars,
    s.photo_paths,
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
    -- Warnings first. A flagged spot is the one thing on this list somebody
    -- must not miss, and burying it under four green pins would be the same
    -- mistake as deleting it.
    case s.tier
      when 'flagged' then 0
      when 'confirmed' then 1
      when 'corroborated' then 2
      when 'reported' then 3
      else 4 end,
    (s.rule_score + s.model_score) desc,
    s.discovered_at desc
  limit 200;
$$;

grant execute on function public.beacon_spots_near(double precision, double precision, double precision)
  to anon, authenticated;


-- ---------------------------------------------------------------------
--  8. TAKEDOWN, SPLIT IN TWO
--
--  Replaces the migration 13 behaviour where every outcome deleted the spot.
--
--    ticketed / asked_to_leave / posted_no_parking → FLAGGED. Still on the
--    map, red, carrying the reporter's words. The place exists and the next
--    camper will find it with or without us; better they find it with the
--    warning attached.
--
--    gone → WITHDRAWN. Gated, built on, no longer a place. Nothing to warn
--    anybody about because there is nothing there.
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
declare
  caller uuid := auth.uid();
  detail text := nullif(btrim(coalesce(in_detail, '')), '');
begin
  if caller is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to report a spot.');
  end if;

  if not exists (select 1 from public.beacon_spots where id = in_spot) then
    return jsonb_build_object('ok', false, 'message', 'That spot is no longer on the map.');
  end if;

  insert into public.beacon_reports (spot_id, user_id, outcome, detail)
  values (in_spot, caller, in_outcome, detail);

  if in_outcome = 'gone' then
    update public.beacon_spots
       set tier = 'withdrawn',
           withdrawn_at = now(),
           withdrawn_reason = coalesce(detail, 'A camper found this is not a place you can park any more.')
     where id = in_spot;

    perform public.grant_points(caller, 8, 'beacon_takedown'::public.points_reason,
      'beacon_spots', in_spot::text, 'Reported a beacon spot as gone');

    return jsonb_build_object('ok', true, 'tier', 'withdrawn',
      'message', 'Thank you — that one is off the map now.');
  end if;

  -- Everything else is a warning, not a deletion. Recorded as a knock on the
  -- camper's own visit row when they have one, so the distinct-camper count
  -- behind knock_count stays honest.
  insert into public.beacon_visits (spot_id, user_id, got_knocked, comment, accepted, geom)
  values (in_spot, caller, true, detail, true,
          (select geom from public.beacon_spots where id = in_spot))
  on conflict (spot_id, user_id) where accepted
  do update set got_knocked = true,
                comment = coalesce(excluded.comment, beacon_visits.comment);

  perform public.beacon_refresh_spot_stats(in_spot);

  perform public.grant_points(caller, 8, 'beacon_takedown'::public.points_reason,
    'beacon_spots', in_spot::text, 'Reported enforcement at a beacon spot');

  return jsonb_build_object('ok', true, 'tier', 'flagged',
    'message', 'Thank you. This spot is red for everyone now, with your note on it — it stays on the map so the next camper sees the warning instead of parking here anyway.');
end;
$$;

grant execute on function public.beacon_report_spot(uuid, public.beacon_outcome, text)
  to authenticated;


-- ---------------------------------------------------------------------
--  9. THE OVERNIGHT PATH, REWRITTEN TO CLIMB THE SAME LADDER
--
--  Replaces the migration 13 function outright rather than patching around
--  it. That version set the tier inline from its own two-rung rule, so
--  leaving it in place would have meant two ladders that disagree the moment
--  a spot gets one report of each kind.
--
--  The dwell and anti-spoof checks are carried over UNCHANGED and are still
--  the only thing that decides what 'overnight' means. What changes:
--
--    - it takes the full report and writes a beacon_visits row with
--      stayed_overnight = true, so a four-hour stay produces the same rich
--      data as a quick report and is marked as the stronger evidence it is
--    - restricted signs FLAG the spot rather than deleting it
--    - the tier comes from beacon_refresh_spot_stats, like everywhere else
--
--  The signature gains a parameter, so the old one is dropped first — a
--  `create or replace` with a different argument count would leave both.
-- ---------------------------------------------------------------------

drop function if exists public.beacon_submit_verification(
  uuid, double precision, double precision, double precision, text, jsonb);

create or replace function public.beacon_submit_verification(
  in_spot       uuid,
  in_lat        double precision,
  in_lon        double precision,
  in_accuracy   double precision,
  in_photo_path text,
  in_answers    jsonb,
  in_report     jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller     uuid := auth.uid();
  ping       jsonb;
  spot       public.beacon_spots%rowtype;
  first_at   timestamptz;
  dwell      integer;
  restricted boolean;
  far_away   integer;
  new_tier   public.beacon_tier;
  verifiers  integer;
  knocked    boolean := coalesce((in_report ->> 'gotKnocked')::boolean, false);
  photos     text[] := coalesce(
                 (select array_agg(value::text)
                    from jsonb_array_elements_text(
                      case when jsonb_typeof(in_report -> 'photoPaths') = 'array'
                           then in_report -> 'photoPaths' else '[]'::jsonb end
                    ) as value),
                 '{}'::text[]);
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
  if not found then
    return jsonb_build_object('ok', false, 'message', 'That spot is no longer on the map.');
  end if;

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

  insert into public.beacon_verifications
    (spot_id, user_id, arrived_at, dwell_minutes, photo_path, answers, accepted)
  values (in_spot, caller, first_at, dwell, in_photo_path,
          coalesce(in_answers, '{}'::jsonb), true);

  /**
   * The camper's own report, marked as the stronger evidence it is.
   *
   * Restricted signage counts as a knock here: it is the same fact from the
   * next camper's point of view — you cannot sleep here without a problem —
   * and routing it through the same column is what keeps knock_count, the
   * red pin and the warning text consistent.
   */
  delete from public.beacon_visits
   where spot_id = in_spot and user_id = caller and accepted;

  insert into public.beacon_visits (
    spot_id, user_id,
    crowding, rating, view_rating, max_rig, road_access,
    level_ground, shade, night_light,
    has_shower, has_restroom, has_fuel,
    got_knocked, comment, photo_paths, stayed_overnight,
    cell_bars, cell_carrier,
    geom, accuracy_m, accepted
  ) values (
    in_spot, caller,
    (in_report ->> 'crowding')::smallint,
    (in_report ->> 'rating')::smallint,
    (in_report ->> 'view')::smallint,
    (in_report ->> 'maxRig')::smallint,
    (in_report ->> 'roadAccess')::smallint,
    (in_report ->> 'levelGround')::smallint,
    (in_report ->> 'shade')::smallint,
    (in_report ->> 'nightLight')::smallint,
    (in_report ->> 'hasShower')::boolean,
    (in_report ->> 'hasRestroom')::boolean,
    (in_report ->> 'hasFuel')::boolean,
    knocked or restricted,
    coalesce(nullif(in_report ->> 'comment', ''), nullif(in_answers ->> 'note', '')),
    case when array_length(photos, 1) is null
         then array[in_photo_path] else photos end,
    true,
    (in_report ->> 'cellBars')::smallint,
    nullif(in_report ->> 'cellCarrier', ''),
    st_setsrid(st_makepoint(in_lon, in_lat), 4326), in_accuracy, true
  );

  if restricted or knocked then
    insert into public.beacon_reports (spot_id, user_id, outcome, detail)
    values (in_spot, caller,
            case when restricted then 'posted_no_parking' else 'asked_to_leave' end,
            coalesce(nullif(in_report ->> 'comment', ''), nullif(in_answers ->> 'note', '')));
  end if;

  perform public.beacon_refresh_spot_stats(in_spot);

  select tier, verify_count into new_tier, verifiers
    from public.beacon_spots where id = in_spot;

  perform public.grant_points(caller, 15, 'beacon_verify'::public.points_reason,
    'beacon_spots', in_spot::text, 'Vouched for a beacon spot after a four-hour stay');

  if restricted or knocked then
    perform public.grant_points(caller, 8, 'beacon_takedown'::public.points_reason,
      'beacon_spots', in_spot::text, 'Reported a problem at a beacon spot');
  end if;

  return jsonb_build_object(
    'ok', true, 'accepted', true,
    'dwell_minutes', dwell,
    'verifiers', verifiers,
    'tier', new_tier,
    'flagged', (restricted or knocked),
    'message', case
      when restricted or knocked
        then 'Thank you — that spot is red for everyone now, with your note on it. It stays on the map so the next camper sees the warning rather than parking here anyway.'
      when verifiers >= 4
        then 'Confirmed. Enough campers have now stayed here that it shows green.'
      when verifiers = 3 then 'Logged. One more camper and this one turns green.'
      when verifiers = 2 then 'Logged. A second camper agreeing is what moves this one up.'
      else 'Logged. This spot now says one camper has actually slept here.'
    end
  );
end;
$$;

grant execute on function public.beacon_submit_verification(uuid, double precision, double precision, double precision, text, jsonb, jsonb)
  to authenticated;


-- ---------------------------------------------------------------------
--  10. SIGNS-RESTRICTED NO LONGER DELETES EITHER
--
--  Migration 13 withdrew a spot when a camper answered "yes, there are
--  restricted signs". Same reasoning as the knock: the pullout is still
--  there. Flagged and visible, with the reason attached.
-- ---------------------------------------------------------------------

update public.beacon_spots
   set tier = 'flagged',
       withdrawn_at = null,
       knock_count = greatest(knock_count, 1),
       last_knock_at = coalesce(last_knock_at, withdrawn_at, now()),
       last_knock_note = coalesce(last_knock_note, withdrawn_reason)
 where withdrawn_at is not null
   and coalesce(withdrawn_reason, '') not ilike '%not a place%'
   and exists (
     select 1 from public.beacon_reports r
      where r.spot_id = beacon_spots.id
        and r.outcome in ('ticketed', 'asked_to_leave', 'posted_no_parking')
   );


-- ---------------------------------------------------------------------
--  11. BACKFILL THE LADDER
--
--  Existing spots were tiered by the old two-rung rule. Re-derive them all
--  so the map is consistent from the first load after this migration.
-- ---------------------------------------------------------------------

update public.beacon_spots s
   set verify_count = coalesce((
         select count(distinct v.user_id)
           from public.beacon_verifications v
          where v.spot_id = s.id and v.accepted), 0)
 where s.withdrawn_at is null;

update public.beacon_spots s
   set tier = public.beacon_tier_for(s.verify_count, s.knock_count)
 where s.withdrawn_at is null;


-- ---------------------------------------------------------------------
--  12. DECAY, RETUNED FOR FOUR RUNGS
--
--  Six months with nobody checking in and a spot drops ONE rung rather than
--  falling straight to 'reported'. Land use changes, signs go up, gates get
--  locked — but a spot four campers vouched for a year ago is still better
--  evidence than one nobody has ever visited.
--
--  Flagged spots never decay. A knock does not become less true with age.
-- ---------------------------------------------------------------------

--  Replaces the migration 13 body under the SAME NAME. `beacon_maintenance()`
--  calls `beacon_decay()`, so adding a differently-named function beside it
--  would leave the nightly job running the old two-rung rule for ever.

create or replace function public.beacon_decay()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare touched integer;
begin
  with stale as (
    update public.beacon_spots
       set verify_count = greatest(verify_count - 1, 1)
     where withdrawn_at is null
       -- Flagged spots are absent from this list on purpose. A knock does not
       -- become less true with age, and quietly ageing a red pin back to
       -- amber would erase a warning nobody withdrew.
       and tier in ('reported', 'corroborated', 'confirmed')
       and coalesce(last_confirmed_at, discovered_at) < now() - interval '6 months'
    returning id, verify_count, knock_count
  )
  update public.beacon_spots s
     set tier = public.beacon_tier_for(stale.verify_count, stale.knock_count)
    from stale
   where s.id = stale.id;

  get diagnostics touched = row_count;
  return touched;
end;
$$;

comment on function public.beacon_decay() is
  'Six months with nobody checking in drops a spot ONE rung, not all the way. Flagged spots never decay.';


-- ---------------------------------------------------------------------
--  12b. POINTS RULE FOR THE NEW REASON
--
--  Without a row here `grant_points` has no amount or cap to apply. The cap
--  is what stops somebody farming points by reporting on ten spots along one
--  road; six a day matches the new-spot ceiling in beacon_create_spot.
-- ---------------------------------------------------------------------

insert into public.points_rules (reason, amount, daily_cap, description)
values ('spot_report', 10, 6, 'Reported on a camping spot you were standing at')
on conflict (reason) do update
  set amount = excluded.amount,
      daily_cap = excluded.daily_cap,
      description = excluded.description;


-- ---------------------------------------------------------------------
--  13. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------

alter table public.beacon_visits enable row level security;

do $$ begin
  -- A camper can read their own reports back. Everyone else sees the
  -- aggregates on the spot, never the individual rows — those carry the
  -- reporter's position at submission time.
  create policy "read: own beacon visits" on public.beacon_visits
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- No insert or update policy, deliberately. Writes go through
-- beacon_submit_visit and beacon_create_spot, which are SECURITY DEFINER.

grant select on public.beacon_visits to authenticated;

commit;


-- ---------------------------------------------------------------------
--  14. STORAGE FOR SPOT PHOTOS
--
--  A SECOND bucket, public-read, and the distinction from beacon-proof
--  matters.
--
--  `beacon-proof` is evidence: private, foldered by user, nobody browses it.
--  `spot-photos` is content: other campers are meant to look at these, which
--  is the entire reason somebody attaches one. Mixing the two would either
--  publish evidence nobody agreed to publish, or hide the photo that makes
--  the listing worth reading.
--
--  The report sheet says which is which before anybody taps submit.
-- ---------------------------------------------------------------------

do $$
begin
  insert into storage.buckets (id, name, public)
  values ('spot-photos', 'spot-photos', true)
  on conflict (id) do nothing;
exception when others then
  raise notice 'Could not create the spot-photos bucket (%).', sqlerrm;
end $$;

do $$ begin
  create policy "insert: own spot photo" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'spot-photos'
                and (storage.foldername(name))[1] = auth.uid()::text);
exception
  when duplicate_object then null;
  when others then raise notice 'Could not add the spot photo insert policy (%).', sqlerrm;
end $$;

do $$ begin
  create policy "read: spot photos" on storage.objects
    for select using (bucket_id = 'spot-photos');
exception
  when duplicate_object then null;
  when others then raise notice 'Could not add the spot photo read policy (%).', sqlerrm;
end $$;

do $$ begin
  -- Deleting your own photo. The report stays; the image comes down.
  create policy "delete: own spot photo" on storage.objects
    for delete to authenticated
    using (bucket_id = 'spot-photos'
           and (storage.foldername(name))[1] = auth.uid()::text);
exception
  when duplicate_object then null;
  when others then raise notice 'Could not add the spot photo delete policy (%).', sqlerrm;
end $$;
