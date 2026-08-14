-- ---------------------------------------------------------------------
--  MIGRATION 16 — AT MOST THREE LEADS PER AREA ON THE MAP
--
--  Run after 15. Safe to re-run.
--
--  WHAT WAS WRONG
--
--  A Beacon scan surfaces the best THREE candidates — `WANTED = 3` in
--  server/beaconRoutes.ts, and the comment there is right: "More than three
--  is a list to trawl, not an answer." But the scan PERSISTS everything
--  scoring above the remember bar, because the model needs losers to learn
--  from, and `beacon_spots_near` then handed every one of them back.
--
--  So one scan of a single gravel loop put fifteen grey rings on the map
--  inside about a kilometre — fourteen of which the scan itself had already
--  judged not worth showing anybody. The map contradicted the panel, and it
--  did it by burying the three real answers in a cloud of near-misses.
--
--  WHAT THIS DOES
--
--  Ranks the leads inside each ~5 km cell by score and returns the best
--  three. The cap is on what is DRAWN, not on what is stored: the losers
--  stay in the table, keep their feature vectors, and keep training the
--  model. Nothing is deleted.
--
--  WHAT IT NEVER HIDES
--
--  A flagged spot — somebody got a knock on the window there — is exempt and
--  always comes back. That rule is load-bearing and predates this file: a
--  spot that quietly disappears is one the next camper rediscovers on their
--  own and parks at anyway, with the app having known and said nothing. The
--  cap ranks candidates; it does not get to suppress a warning.
--
--  Evidence outranks score, so a spot somebody has actually stood at never
--  loses its place to a better-scoring guess nobody has visited.
-- ---------------------------------------------------------------------

begin;

/**
 * Grid cell size, in degrees, for "the same area".
 *
 * 0.05° is roughly 5.5 km north-south — the outer rung of the scan's own
 * RADIUS_LADDER, so one scan's results land in one or two cells. Snapping to
 * a grid can split a cluster that straddles a line, which shows four leads
 * instead of three across that boundary. That is the acceptable direction to
 * be wrong in: showing one extra lead is untidy, and the alternative (true
 * clustering) costs a self-join on every map pan.
 */
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
  with in_range as (
    select s.*
    from public.beacon_spots s
    where s.withdrawn_at is null
      and st_dwithin(
            s.geom::geography,
            st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography,
            least(coalesce(in_radius_km, 25), 200) * 1000
          )
  ),
  ranked as (
    select
      r.*,
      row_number() over (
        partition by
          floor(st_y(r.geom) / 0.05),
          floor(st_x(r.geom) / 0.05)
        order by
          -- Evidence first: a spot a camper has stood at outranks a
          -- better-scoring guess nobody has been to.
          case r.tier
            when 'confirmed' then 0
            when 'corroborated' then 1
            when 'reported' then 2
            else 3
          end,
          (r.rule_score + r.model_score) desc,
          r.discovered_at desc
      ) as rank_in_area
    from in_range r
  )
  select
    k.id, st_y(k.geom), st_x(k.geom), k.tier, k.generator,
    k.label, k.land_basis, k.sign_evidence,
    k.verify_count, k.visit_count, k.knock_count, k.last_knock_at, k.last_knock_note,
    k.avg_crowding, k.avg_rating, k.avg_view, k.avg_max_rig, k.avg_road_access,
    k.avg_level_ground, k.avg_shade, k.avg_night_light, k.avg_cell_bars,
    k.photo_paths,
    k.rule_score, k.model_score, k.region,
    k.discovered_at, k.last_confirmed_at
  from ranked k
  -- Three per area, and every flagged spot regardless of where it ranks.
  where k.rank_in_area <= 3 or k.tier = 'flagged'
  order by
    -- Flagged first, exactly as before: burying a knock under three green
    -- pins would be the same mistake as deleting it.
    case k.tier when 'flagged' then 0 when 'confirmed' then 1
                when 'corroborated' then 2 when 'reported' then 3 else 4 end,
    (k.rule_score + k.model_score) desc,
    k.discovered_at desc
  limit 200;
$$;

comment on function public.beacon_spots_near(double precision, double precision, double precision) is
  'Live beacon spots near a point, capped at the best three per ~5 km area to match what a scan actually surfaces. Flagged spots are exempt and always returned. The cap is on what is drawn, never on what is stored — the rest still train the model.';

grant execute on function public.beacon_spots_near(double precision, double precision, double precision)
  to anon, authenticated;

commit;
