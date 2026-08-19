/*
 * ---------------------------------------------------------------------------
 * MIGRATION 21 — THE MAP STORES WHAT IT FETCHES
 * ---------------------------------------------------------------------------
 *
 * `public_lands` has been empty since the day it was created, and every
 * boundary a camper has ever seen came straight off a government ArcGIS
 * server. `npm run seed` was always the intended filler and it has never run:
 * seeding needs a machine that can reach eight government services, and the
 * only machine that reliably can is the deployed API itself.
 *
 * So the API fills the table out of the fetches it is already making. Four
 * things had to exist first.
 *
 * 1. THE PROVENANCE COLUMNS WERE GONE. `boundaries_in_bbox` selects
 *    `p.edge_accuracy` and `p.camping_basis_kind`, migration 03 added them,
 *    and a later re-run of the destructive `supabase_schema.sql` recreated the
 *    table without them. So the seeded read path answered "column does not
 *    exist" on every single request — and because every service turns an error
 *    into its safe empty value, the symptom was not an error anywhere. It was
 *    a map that silently always used the live services.
 *
 * 2. `land_sources` WAS EMPTY, and `public_lands.source_id` references it. No
 *    parcel could have been stored even if the seeder had run.
 *
 * 3. THERE WAS NOWHERE TO RECORD WHAT HAD BEEN STORED. Without that, a
 *    half-filled table is WORSE than an empty one: the route served seeded
 *    data whenever it found any, so ground that had not been stored yet would
 *    draw as empty — the map claiming there is no public land in a place
 *    nobody had looked at. `land_ingest_coverage` is what makes filling the
 *    table gradually safe. It holds, per source, the union of every box that
 *    has actually been stored, and the read path uses a source only where that
 *    union CONTAINS the whole viewport.
 *
 *    Coverage is a geometry rather than a grid of cells because viewports are
 *    not grid-shaped: at the zoom where a camper reads parcel edges the screen
 *    is a fraction of a degree, so a one-degree cell would never be completed
 *    and nothing would ever count as covered.
 *
 * 4. NOTHING COULD WRITE A POLYGON. PostgREST will not cast GeoJSON to a
 *    PostGIS geometry, so the insert has to happen inside the database.
 */

/* ---------------------------------------------------------------- */
/* 1. Restore the provenance columns                                  */
/* ---------------------------------------------------------------- */

alter table public.public_lands
  add column if not exists edge_accuracy      public.edge_accuracy,
  add column if not exists camping_basis_kind public.camping_basis_kind;

alter table public.land_sources
  add column if not exists edge_accuracy      public.edge_accuracy,
  add column if not exists camping_basis_kind public.camping_basis_kind,
  add column if not exists is_comprehensive   boolean not null default false,
  add column if not exists known_limitations  text;

/* ---------------------------------------------------------------- */
/* 2. What ground has actually been stored                            */
/* ---------------------------------------------------------------- */

create table if not exists public.land_ingest_coverage (
  source_id  text primary key references public.land_sources(id) on delete cascade,
  geom       geometry(MultiPolygon, 4326) not null,
  boxes      integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists land_ingest_coverage_geom_idx
  on public.land_ingest_coverage using gist (geom);

alter table public.land_ingest_coverage enable row level security;

drop policy if exists land_ingest_coverage_readable on public.land_ingest_coverage;
create policy land_ingest_coverage_readable
  on public.land_ingest_coverage for select
  using (true);

/* ---------------------------------------------------------------- */
/* 3. Store parcels                                                   */
/* ---------------------------------------------------------------- */

/*
 * Features arrive as the API's own GeoJSON, so the properties are the
 * underscore-prefixed names the rest of the app already speaks.
 *
 * `_externalId` is the parcel's id at its source — ArcGIS and WFS both put it
 * on the feature rather than in its properties — and it is what makes storing
 * the same parcel twice an update instead of a duplicate. A feature without
 * one is skipped rather than given a synthetic id: the obvious synthetic id
 * would be a hash of the geometry, and the geometry changes with the zoom it
 * was generalised for, so every zoom would store the parcel again as new.
 *
 * A feature with no polygon, or no basis for saying camping is allowed, is
 * skipped too. `public_lands` is constrained to campable land and there is no
 * honest row to write for either case.
 */
create or replace function public.ingest_land_parcels(
  in_source_id  text,
  in_features   jsonb
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  f      jsonb;
  props  jsonb;
  g      geometry;
  ext_id text;
  basis  text;
  stored integer := 0;
begin
  if in_features is null or jsonb_typeof(in_features) <> 'array' then
    return 0;
  end if;

  for f in select * from jsonb_array_elements(in_features)
  loop
    props := coalesce(f -> 'properties', '{}'::jsonb);

    basis  := nullif(btrim(coalesce(props ->> '_basis', props ->> '_designation', '')), '');
    ext_id := nullif(btrim(coalesce(props ->> '_externalId', '')), '');
    if basis is null or ext_id is null then
      continue;
    end if;

    begin
      g := st_multi(st_makevalid(st_geomfromgeojson(f ->> 'geometry')));
    exception when others then
      continue;
    end;

    if g is null or st_isempty(g) or st_geometrytype(g) <> 'ST_MultiPolygon' then
      continue;
    end if;

    g := st_setsrid(g, 4326);

    insert into public.public_lands (
      source_id, external_id, name, designation, confidence,
      edge_accuracy, camping_basis_kind, jurisdiction,
      camping_allowed, general_use_basis, stay_limit_days,
      permit_required, permit_name,
      geom, area_sq_km, synced_at
    )
    values (
      in_source_id,
      ext_id,
      nullif(props ->> '_name', ''),
      nullif(props ->> '_designation', ''),
      (props ->> '_confidence')::public.boundary_confidence,
      nullif(props ->> '_edgeAccuracy', '')::public.edge_accuracy,
      nullif(props ->> '_campingBasisKind', '')::public.camping_basis_kind,
      nullif(props ->> '_jurisdiction', ''),
      true,
      basis,
      nullif(props ->> '_stayLimitDays', '')::integer,
      nullif(props ->> '_permitRequired', '')::boolean,
      nullif(props ->> '_permitName', ''),
      g,
      st_area(g::geography) / 1000000.0,
      now()
    )
    on conflict (source_id, external_id) do update set
      name               = excluded.name,
      designation        = excluded.designation,
      confidence         = excluded.confidence,
      edge_accuracy      = excluded.edge_accuracy,
      camping_basis_kind = excluded.camping_basis_kind,
      general_use_basis  = excluded.general_use_basis,
      stay_limit_days    = excluded.stay_limit_days,
      permit_required    = excluded.permit_required,
      permit_name        = excluded.permit_name,
      geom               = excluded.geom,
      area_sq_km         = excluded.area_sq_km,
      synced_at          = now();

    stored := stored + 1;
  end loop;

  return stored;
end;
$$;

revoke all on function public.ingest_land_parcels(text, jsonb) from public, anon, authenticated;

/* ---------------------------------------------------------------- */
/* 4. Record, and read back, what is covered                          */
/* ---------------------------------------------------------------- */

create or replace function public.record_land_coverage(
  in_source_id text,
  in_min_lat   double precision,
  in_min_lon   double precision,
  in_max_lat   double precision,
  in_max_lon   double precision
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  box geometry;
begin
  box := st_multi(st_makeenvelope(in_min_lon, in_min_lat, in_max_lon, in_max_lat, 4326));

  insert into public.land_ingest_coverage (source_id, geom, boxes, updated_at)
  values (in_source_id, box, 1, now())
  on conflict (source_id) do update set
    geom       = st_multi(st_union(public.land_ingest_coverage.geom, excluded.geom)),
    boxes      = public.land_ingest_coverage.boxes + 1,
    updated_at = now();
end;
$$;

revoke all on function public.record_land_coverage(text, double precision, double precision, double precision, double precision) from public, anon, authenticated;

/*
 * ST_COVERS, NOT ST_INTERSECTS, AND THAT IS THE WHOLE SAFETY PROPERTY.
 *
 * A source whose stored coverage merely touches the viewport is not usable:
 * the part of the screen it does not cover would draw as empty, and an empty
 * map that looks confident is the worst thing this app can do.
 */
create or replace function public.land_sources_covering(
  in_min_lat double precision,
  in_min_lon double precision,
  in_max_lat double precision,
  in_max_lon double precision
) returns table (source_id text)
language sql
stable
set search_path = public, pg_temp
as $$
  select c.source_id
  from public.land_ingest_coverage c
  where st_covers(c.geom, st_makeenvelope(in_min_lon, in_min_lat, in_max_lon, in_max_lat, 4326));
$$;

grant execute on function public.land_sources_covering(double precision, double precision, double precision, double precision) to anon, authenticated;

/*
 * The read, filtered to the sources that actually cover the box.
 *
 * `boundaries_in_bbox` answers for every source at once, which was fine while
 * the table was all-or-nothing and is wrong now: this response mixes stored
 * sources with live ones, and asking the database for a source it only
 * partly holds would draw that source's gaps as empty land.
 */
create or replace function public.boundaries_in_bbox_sources(
  in_min_lat        double precision,
  in_min_lon        double precision,
  in_max_lat        double precision,
  in_max_lon        double precision,
  in_tolerance      double precision default 0.0005,
  in_limit          integer default 1200,
  in_min_area_sq_km double precision default 0,
  in_source_ids     text[] default null
) returns jsonb
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
      p.source_id, p.name, p.designation, p.confidence,
      p.edge_accuracy, p.camping_basis_kind, p.general_use_basis,
      p.stay_limit_days, p.permit_required, p.permit_name,
      s.label as source_label, s.attribution as attribution,
      st_simplifypreservetopology(
        st_intersection(p.geom, (select g from box)),
        greatest(in_tolerance, 0.00001)
      ) as geom,
      p.area_sq_km
    from public.public_lands p
    join public.land_sources s on s.id = p.source_id
    where p.camping_allowed
      and (in_source_ids is null or p.source_id = any(in_source_ids))
      and p.geom && (select g from box)
      and (
        in_min_area_sq_km <= 0
        or p.area_sq_km is null
        or p.area_sq_km >= in_min_area_sq_km
      )
      and st_intersects(p.geom, (select g from box))
    order by p.area_sq_km desc nulls last
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
            '_stayLimitDays',    h.stay_limit_days,
            '_permitRequired',   h.permit_required,
            '_permitName',       h.permit_name
          )
        )
      ) filter (where h.geom is not null and not st_isempty(h.geom)),
      '[]'::jsonb
    )
  )
  from hits h;
$$;

grant execute on function public.boundaries_in_bbox_sources(double precision, double precision, double precision, double precision, double precision, integer, double precision, text[]) to anon, authenticated;
