-- =====================================================================
--  06. SERVING BOUNDARIES OUT OF THE DATABASE
--
--  Run after 01-05.
--
--  WHY
--
--  `npm run seed` has always written every public land polygon into
--  public.public_lands — and nothing has ever read it. /api/boundaries
--  proxied five live government ArcGIS services on every request instead, so
--  seeding changed nothing about what the map drew. It also meant the map was
--  only ever as available as those services were, and every viewport cost a
--  round trip to them.
--
--  This adds the one thing that was missing: a bounding-box lookup that
--  returns GeoJSON in the exact shape the client already parses.
--
--  WHAT IT DOES NOT DO
--
--  It does not invent coverage. The function returns what has been seeded and
--  nothing else, so an unseeded database returns an empty collection and the
--  API falls back to querying the live services — which is what makes this
--  safe to deploy before anyone runs a seed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Boundaries intersecting a bounding box, WITH THE RULES THAT APPLY.
--
-- The rules matter as much as the polygon. Knowing a parcel is BLM land is
-- only half of what a camper needs; the other half is the stay limit, whether
-- a permit is required and where to get one, whether there is a fire ban in
-- force right now, and how far from water they have to be. Those live in
-- land_regulations and are joined here so the map can show them on tap.
--
-- Everything returned under a rules key comes from the land manager. Nothing a
-- camper submitted ever reaches these fields.
--
-- Geometry is simplified server-side to `in_tolerance` degrees. The caller
-- passes a tolerance derived from the viewport span, so a zoomed-out request
-- moves far less coordinate data than a zoomed-in one — the same trick the
-- ArcGIS proxy plays with maxAllowableOffset.
--
-- ST_SimplifyPreserveTopology, not ST_Simplify: the plain version can turn a
-- polygon inside out or drop rings entirely at aggressive tolerances, and a
-- self-intersecting land boundary would render as garbage.
--
-- Rows are ordered so that if the caller's limit truncates the result, what
-- survives is the most trustworthy and the most substantial: explicit
-- general-use designations first, then largest area.
-- ---------------------------------------------------------------------
create or replace function public.boundaries_in_bbox(
  in_min_lat   double precision,
  in_min_lon   double precision,
  in_max_lat   double precision,
  in_max_lon   double precision,
  in_tolerance double precision default 0.0005,
  in_limit     integer          default 1200
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with box as (
    select st_makeenvelope(in_min_lon, in_min_lat, in_max_lon, in_max_lat, 4326) as g
  ),
  hits as (
    select
      p.source_id,
      p.name,
      p.designation,
      p.confidence,
      p.edge_accuracy,
      p.camping_basis_kind,
      p.general_use_basis,
      -- A regulation row overrides the polygon's own defaults where it exists,
      -- because it is the more specific and more maintainable record.
      coalesce(r.stay_limit_days, p.stay_limit_days) as stay_limit_days,
      coalesce(r.permit_required, p.permit_required) as permit_required,
      coalesce(r.permit_name,     p.permit_name)     as permit_name,
      r.permit_url,
      r.move_distance_km,
      r.campfire_policy,
      coalesce(r.fire_ban_active, false) as fire_ban_active,
      r.fire_ban_checked_at,
      r.waste_policy,
      r.setback_water_m,
      r.leave_no_trace,
      p.restrictions,
      s.label       as source_label,
      s.attribution as attribution,
      -- Clip to the requested box before simplifying: a province-sized polygon
      -- costs the same to send as a small one otherwise.
      st_simplifypreservetopology(
        st_intersection(p.geom, (select g from box)),
        greatest(in_tolerance, 0.00001)
      ) as geom,
      p.area_sq_km
    from public.public_lands p
    join public.land_sources s on s.id = p.source_id
    -- Rules currently in force for this parcel, if anyone has recorded any.
    left join public.land_regulations r
      on r.land_id = p.id
     and (r.effective_from is null or r.effective_from <= current_date)
     and (r.effective_to   is null or r.effective_to   >= current_date)
    where p.camping_allowed
      and p.geom && (select g from box)
      and st_intersects(p.geom, (select g from box))
    order by
      (p.confidence = 'designated_general_use') desc,
      p.area_sq_km desc nulls last
    limit greatest(in_limit, 1)
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'type', 'Feature',
          'geometry', st_asgeojson(h.geom)::jsonb,
          'properties', jsonb_build_object(
            '_source',           h.source_id,
            '_sourceName',       h.source_label,
            '_attribution',      h.attribution,
            '_confidence',       h.confidence,
            '_edgeAccuracy',     h.edge_accuracy,
            '_campingBasisKind', h.camping_basis_kind,
            '_name',             h.name,
            '_designation',      h.designation,
            '_basis',            h.general_use_basis,
            -- The rules that apply to this specific land. Everything below is
            -- from the land manager, never from a camper's report.
            '_stayLimitDays',    h.stay_limit_days,
            '_moveDistanceKm',   h.move_distance_km,
            '_permitRequired',   h.permit_required,
            '_permitName',       h.permit_name,
            '_permitUrl',        h.permit_url,
            '_campfirePolicy',   h.campfire_policy,
            '_fireBanActive',    h.fire_ban_active,
            '_fireBanCheckedAt', h.fire_ban_checked_at,
            '_wastePolicy',      h.waste_policy,
            '_setbackWaterM',    h.setback_water_m,
            '_leaveNoTrace',     h.leave_no_trace,
            '_restrictions',     h.restrictions
          )
        )
      ) filter (where h.geom is not null and not st_isempty(h.geom)),
      '[]'::jsonb
    )
  )
  from hits h;
$$;

comment on function public.boundaries_in_bbox is
  'Seeded public land intersecting a bbox, as a GeoJSON FeatureCollection in the shape /api/boundaries returns. Empty when nothing has been seeded, which the API treats as "fall back to the live services".';

-- Anon may read boundaries (see the RLS policy in supabase_schema.sql), so the
-- API can use the public key rather than a service role.
grant execute on function public.boundaries_in_bbox(
  double precision, double precision, double precision, double precision,
  double precision, integer
) to anon, authenticated;

-- ---------------------------------------------------------------------
-- What has actually been seeded.
--
-- The API reports per-source counts so the map legend can name real sources.
-- Doing it in one round trip keeps it off the hot path.
-- ---------------------------------------------------------------------
create or replace function public.seeded_land_sources()
returns table (
  id            text,
  label         text,
  attribution   text,
  confidence    public.boundary_confidence,
  jurisdiction  text,
  feature_count bigint,
  last_synced   timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    s.id,
    s.label,
    s.attribution,
    -- A source can hold more than one tier; report the one it mostly asserts.
    mode() within group (order by p.confidence) as confidence,
    p.jurisdiction,
    count(*)          as feature_count,
    max(p.synced_at)  as last_synced
  from public.public_lands p
  join public.land_sources s on s.id = p.source_id
  where p.camping_allowed
  group by s.id, s.label, s.attribution, p.jurisdiction
  order by count(*) desc;
$$;

comment on function public.seeded_land_sources is
  'Per-source counts of seeded public land. Empty until npm run seed has run.';

grant execute on function public.seeded_land_sources() to anon, authenticated;

-- =====================================================================
--  AFTER RUNNING THIS
--
--    1. Seed the boundaries (needs SUPABASE_SERVICE_ROLE_KEY):
--         npm run probe          -- check every source first
--         npm run seed -- --lands
--
--    2. Confirm the API can see them:
--         select * from public.seeded_land_sources();
--
--    3. /api/boundaries will now serve from here, and only fall back to the
--       live ArcGIS services for viewports the database has nothing for.
--       The response says which path answered, under meta.servedFrom.
-- =====================================================================