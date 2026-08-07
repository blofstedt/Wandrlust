-- =====================================================================
--  Wandrlust — Migration 03: Data provenance & honest accuracy metadata
--
--  Run AFTER migration 02. Additive.
--
--  WHY THIS EXISTS
--
--  The app was about to present three very different things as one green
--  "public land" fill:
--    * an Ontario polygon explicitly designated General Use Area
--    * a BLM administrative boundary that says nothing about camping
--    * a PAD-US polygon flagged open-access but not camping-approved
--
--  Worse, absence of a polygon read as "no public land here" when it
--  usually meant "we have no data for this province."
-- =====================================================================

begin;

drop type if exists public.edge_accuracy      cascade;
drop type if exists public.camping_basis_kind cascade;

/*
 * How accurate are this polygon's boundaries?
 * NOTHING here is survey-grade. BLM's own SMA metadata states the data
 * "do not illustrate land status ownership pattern boundaries".
 */
create type public.edge_accuracy as enum (
  'generalised',        -- cartographic; edges may be off by hundreds of metres
  'administrative',     -- agency boundary; good regional shape, not survey-grade
  'cadastral_derived'   -- from a survey fabric; best available, still not legal
);

/** On what basis do we claim camping is allowed here? */
create type public.camping_basis_kind as enum (
  'explicit_designation',     -- source designates it for general/dispersed use
  'open_access_flag',         -- source says public access open; camping inferred
  'agency_policy_inference'   -- only the agency is known; camping inferred
);

alter table public.land_sources
  add column if not exists edge_accuracy      public.edge_accuracy,
  add column if not exists camping_basis_kind public.camping_basis_kind,
  add column if not exists is_comprehensive   boolean not null default false,
  add column if not exists known_limitations  text;

comment on column public.land_sources.is_comprehensive is
  'True only when this source covers its whole declared jurisdiction. False means partial — e.g. Alberta PLUZ covers designated zones, not all Crown land.';

alter table public.public_lands
  add column if not exists edge_accuracy public.edge_accuracy
    not null default 'administrative',
  add column if not exists camping_basis_kind public.camping_basis_kind
    not null default 'agency_policy_inference',
  add column if not exists extraction_run_id uuid;

create index if not exists public_lands_basis_idx
  on public.public_lands (camping_basis_kind);

-- ---------------------------------------------------------------------
-- Coverage gaps
--
-- Lets the map distinguish "no public land here" from "no data here".
-- Without this the app implies British Columbia has no Crown land.
-- ---------------------------------------------------------------------
create table if not exists public.coverage_gaps (
  id           bigint generated always as identity primary key,
  jurisdiction text not null,
  region       text not null,
  reason       text not null,
  geom         geometry(MultiPolygon, 4326),
  bbox_minlon  double precision,
  bbox_minlat  double precision,
  bbox_maxlon  double precision,
  bbox_maxlat  double precision,
  recorded_at  timestamptz not null default now(),

  constraint coverage_gaps_unique unique (jurisdiction, region)
);

comment on table public.coverage_gaps is
  'Regions with NO boundary data. Absence of a polygon there means unknown, not absent.';

create index if not exists coverage_gaps_geom_idx on public.coverage_gaps using gist (geom);

insert into public.coverage_gaps
  (jurisdiction, region, reason, bbox_minlon, bbox_minlat, bbox_maxlon, bbox_maxlat)
values
  ('CA-BC', 'British Columbia',
   'No open layer of campable Crown land. ParcelMap BC is a cadastral fabric that disclaims legal-boundary authority; TANTALIS publishes Crown tenures, which are encumbrances rather than freely campable land.',
   -139.1, 48.3, -114.0, 60.0),
  ('CA-MB', 'Manitoba',
   'Manitoba operates a geoportal but publishes no confirmed open REST layer delineating campable Crown land.',
   -102.0, 48.9, -88.9, 60.0),
  ('CA-QC', 'Quebec',
   'Terres du domaine de l''Etat are administered via MRNF with no confirmed open REST endpoint for general-use camping areas.',
   -79.8, 44.9, -57.1, 62.6),
  ('CA-ATL', 'Atlantic Canada (NB, NS, PE, NL)',
   'Provincial Crown land datasets are published as periodic file downloads rather than queryable services.',
   -69.1, 43.4, -52.6, 60.4),
  ('CA-NORTH', 'Yukon, Northwest Territories, Nunavut',
   'Land administration is split between territorial and federal jurisdiction with significant Indigenous land claim settlement areas. Deliberately not modelled — misrepresenting these boundaries would be worse than showing nothing.',
   -141.0, 60.0, -60.0, 83.2),
  ('US-STATE', 'US state trust and state forest lands',
   'State camping rules vary by state and are absent from the federal SMA layer. PAD-US covers some state lands where Pub_Access is populated, but coverage is uneven.',
   -125.0, 24.5, -66.9, 49.5)
on conflict (jurisdiction, region) do update
  set reason = excluded.reason, recorded_at = now();

-- ---------------------------------------------------------------------
-- Extraction audit
--
-- Records whether a seed run was provably complete. If any tile was still
-- truncated at max recursion depth, that is recorded rather than glossed over.
-- ---------------------------------------------------------------------
create table if not exists public.extraction_runs (
  id                    uuid primary key default gen_random_uuid(),
  source_id             text not null references public.land_sources(id) on delete cascade,
  started_at            timestamptz not null default now(),
  finished_at           timestamptz,

  tiles_queried         integer not null default 0,
  tiles_subdivided      integer not null default 0,
  features_fetched      integer not null default 0,
  unique_features       integer not null default 0,
  features_stored       integer not null default 0,
  features_rejected     integer not null default 0,
  errors                integer not null default 0,

  -- False when a tile hit the record cap at max depth: extract may be partial.
  completeness_verified boolean not null default false,
  notes                 text
);

create index if not exists extraction_runs_source_idx
  on public.extraction_runs (source_id, started_at desc);

comment on column public.extraction_runs.completeness_verified is
  'True only when every tile returned fewer features than the server cap, proving nothing was silently truncated.';

-- ---------------------------------------------------------------------
-- Honest reporting helpers
-- ---------------------------------------------------------------------

/**
 * What do we actually know at this point? Returns the land, how much to trust
 * its edges, why we think camping is allowed, and whether the point sits in a
 * known data gap.
 */
create or replace function public.land_confidence_at(
  in_lat double precision, in_lon double precision
)
returns table (
  land_name text, designation text, confidence public.boundary_confidence,
  edge_accuracy public.edge_accuracy, camping_basis_kind public.camping_basis_kind,
  general_use_basis text, attribution text, source_complete boolean,
  in_coverage_gap boolean, gap_reason text
)
language sql stable
set search_path = public, pg_temp
as $$
  with pt as (select st_setsrid(st_makepoint(in_lon, in_lat), 4326) as g),
  gap as (
    select cg.reason
    from public.coverage_gaps cg, pt
    where (cg.geom is not null and st_intersects(cg.geom, pt.g))
       or (cg.geom is null
           and st_x(pt.g) between cg.bbox_minlon and cg.bbox_maxlon
           and st_y(pt.g) between cg.bbox_minlat and cg.bbox_maxlat)
    limit 1
  )
  select
    p.name, p.designation, p.confidence, p.edge_accuracy, p.camping_basis_kind,
    p.general_use_basis, s.attribution, s.is_comprehensive,
    (select count(*) from gap) > 0, (select reason from gap)
  from public.public_lands p
  join public.land_sources s on s.id = p.source_id, pt
  where st_intersects(p.geom, pt.g)
  order by
    p.camping_basis_kind = 'explicit_designation' desc,
    p.confidence = 'designated_general_use' desc
  limit 5;
$$;

/** Per-source data quality dashboard. */
create or replace function public.data_quality_report()
returns table (
  source_id text, label text, jurisdiction text, parcels bigint,
  edge_accuracy public.edge_accuracy, camping_basis_kind public.camping_basis_kind,
  is_comprehensive boolean, last_synced timestamptz,
  last_run_complete boolean, known_limitations text
)
language sql stable
set search_path = public, pg_temp
as $$
  select
    s.id, s.label, s.jurisdiction, count(p.id),
    s.edge_accuracy, s.camping_basis_kind, s.is_comprehensive, s.last_synced,
    (select r.completeness_verified from public.extraction_runs r
      where r.source_id = s.id order by r.started_at desc limit 1),
    s.known_limitations
  from public.land_sources s
  left join public.public_lands p on p.source_id = s.id
  group by s.id, s.label, s.jurisdiction, s.edge_accuracy,
           s.camping_basis_kind, s.is_comprehensive, s.last_synced, s.known_limitations
  order by count(p.id) desc;
$$;

alter table public.coverage_gaps   enable row level security;
alter table public.extraction_runs enable row level security;

create policy "read: coverage gaps" on public.coverage_gaps
  for select to anon, authenticated using (true);

create policy "read: extraction runs" on public.extraction_runs
  for select to anon, authenticated using (true);

grant select on public.coverage_gaps, public.extraction_runs to anon, authenticated;

grant execute on function
  public.land_confidence_at(double precision, double precision),
  public.data_quality_report()
  to anon, authenticated;

-- Backfill source metadata
update public.land_sources set
  edge_accuracy = 'administrative',
  camping_basis_kind = 'agency_policy_inference',
  is_comprehensive = true,
  known_limitations = 'Identifies the managing agency only. BLM states this dataset does not illustrate land ownership boundaries. Private inholdings are not shown. Travel management plans, MVUMs and seasonal closures are not represented.'
where id in ('usa_federal_lands', 'blm_sma_national');

update public.land_sources set
  edge_accuracy = 'administrative',
  camping_basis_kind = 'open_access_flag',
  is_comprehensive = true,
  known_limitations = 'Pub_Access = OA means the public may enter, not that overnight camping is authorised. Coverage of state and local lands is uneven.'
where id in ('usgs_padus', 'padus_open_access');

update public.land_sources set
  edge_accuracy = 'administrative',
  camping_basis_kind = 'explicit_designation',
  is_comprehensive = true,
  known_limitations = 'Ontario states CLUPA is not to be used as a source of protected area, Crown land or private land boundaries. It is a land-use policy layer.'
where id = 'ontario_clupa_general_use';

update public.land_sources set
  edge_accuracy = 'administrative',
  camping_basis_kind = 'explicit_designation',
  is_comprehensive = false,
  known_limitations = 'Covers designated Public Land Use Zones only. Large areas of campable Alberta Crown land fall outside any PLUZ and are absent from this dataset.'
where id = 'alberta_pluz';

commit;

-- =====================================================================
--  POST-INSTALL
--    select * from public.data_quality_report();
--    select * from public.land_confidence_at(51.0447, -114.0719);
-- =====================================================================