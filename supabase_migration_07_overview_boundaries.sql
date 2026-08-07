-- =====================================================================
--  07. AN AREA FILTER, SO THE ZOOMED-OUT MAP CAN DRAW SOMETHING
--
--  Run after 01-06.
--
--  WHY
--
--  Below zoom 7 the map used to draw no boundaries at all. Zoom out to look at
--  a whole state and the public land vanished, which is exactly when somebody
--  is asking "where should I even head?". Turning the detailed query loose at
--  that zoom is not the answer either: a viewport covering Montana holds tens
--  of thousands of parcels, most of them under a pixel across.
--
--  So the client now asks for an OVERVIEW below zoom 7 — the same query, but
--  returning only parcels big enough to see. That threshold is what this
--  migration adds.
--
--  WHY IT IS A DROP AND RECREATE
--
--  `create or replace function` cannot add a parameter. Adding one with a
--  default would create a second overload instead, and a six-argument call
--  would then match both and fail with "function is not unique". The old
--  signature is dropped first so there is exactly one function.
--
--  The server tolerates this migration not having been run: it detects the
--  missing parameter, falls back to the six-argument call, and filters by area
--  itself. Running this just moves that work to the database, where it belongs
--  — the rows never leave Postgres in the first place.
-- =====================================================================

drop function if exists public.boundaries_in_bbox(
  double precision, double precision, double precision, double precision,
  double precision, integer
);

create or replace function public.boundaries_in_bbox(
  in_min_lat         double precision,
  in_min_lon         double precision,
  in_max_lat         double precision,
  in_max_lon         double precision,
  in_tolerance       double precision default 0.0005,
  in_limit           integer          default 1200,
  -- 0 means "everything", which is what the full-detail path passes.
  in_min_area_sq_km  double precision default 0
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
      -- The overview filter. Applied BEFORE the expensive intersection and
      -- simplification, and before the index-backed st_intersects, so a
      -- continent-wide overview query touches a few hundred rows rather than
      -- clipping every polygon in the table.
      --
      -- A parcel with no recorded area is KEPT, not dropped. Missing area is
      -- an unmeasured row, not a small one, and silently hiding public land
      -- because a number is null is the kind of quiet lie this app does not
      -- tell. It just falls to the bottom of the ordering instead.
      and (
        in_min_area_sq_km <= 0
        or p.area_sq_km is null
        or p.area_sq_km >= in_min_area_sq_km
      )
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
  'Seeded public land intersecting a bbox, as a GeoJSON FeatureCollection in the shape /api/boundaries returns. in_min_area_sq_km > 0 returns only parcels at least that large, which is how the zoomed-out overview stays small. Empty when nothing has been seeded, which the API treats as "fall back to the live services".';

grant execute on function public.boundaries_in_bbox(
  double precision, double precision, double precision, double precision,
  double precision, integer, double precision
) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Make the area filter cheap.
--
-- Without this the overview query area-filters by sequential scan over every
-- seeded polygon. Partial, because camping_allowed = false rows are never
-- returned by anything here.
-- ---------------------------------------------------------------------
create index if not exists public_lands_area_idx
  on public.public_lands (area_sq_km desc)
  where camping_allowed;

-- =====================================================================
--  AFTER RUNNING THIS
--
--    select jsonb_array_length(
--      public.boundaries_in_bbox(44.0, -114.0, 49.0, -104.0, 0.02, 500, 1500) -> 'features'
--    );
--
--  should return the count of large parcels across Montana — tens, not
--  thousands. If it returns thousands, the seeded rows have no area_sq_km and
--  are all being kept; re-run `npm run seed -- --lands` to populate it.
-- =====================================================================