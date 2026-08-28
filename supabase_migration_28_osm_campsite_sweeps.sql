-- ---------------------------------------------------------------------
--  28. REMEMBERING WHICH GROUND HAS BEEN SWEPT FOR OSM CAMPSITES
--
--  Until now every camper's BROWSER queried Overpass directly, on every
--  meaningful pan of the map. A thousand campers looking at the same
--  valley meant a thousand identical queries against a volunteer-funded
--  service, and every one of them waited several seconds for an answer
--  somebody else had already been given. The only cache was a ten-minute
--  one in the tab, which died with the tab and helped nobody else.
--
--  Same shape as `land_ingest_coverage` for boundaries and `beacon_scans`
--  for Beacon: record WHAT GROUND was swept and WHEN, so the second
--  person to look at a place pays nothing and waits for nothing.
--
--  NINETY DAYS, as asked for. Campsites in OpenStreetMap do not move,
--  open or close on a shorter timescale, and a campground that is three
--  months stale is a far smaller harm than hammering Overpass. After that
--  the sweep expires and the next camper to look refreshes it for
--  everybody.
--
--  ---------------------------------------------------------------------
--  WHY THE SITES LIVE HERE AND NOT IN `campsites`
--  ---------------------------------------------------------------------
--
--  `campsites_visible` deliberately does not return the amenity columns —
--  see the note on `submitCampsite` — so a campsite read back through it
--  arrives with `amenities: {}`. An OpenStreetMap site's water, toilet and
--  road access come from its TAGS, and routing them through that table
--  would silently throw all of it away. Worse, those columns are NOT NULL
--  with defaults, so an absent `drinking_water` tag would be stored as
--  "no water" — an unanswered question recorded as a finding, which is the
--  one thing this schema keeps having to avoid.
--
--  So the shaped sites ride in the sweep row as jsonb. The cache holds
--  exactly what the browser used to build for itself, and `campsites`
--  stays a table of records somebody is accountable for.
-- ---------------------------------------------------------------------

create table if not exists public.osm_campsite_sweeps (
  -- The rounded centre and the radius, as one string. See `sweepKey` in
  -- server/osmCampsiteRoutes.ts — the two must agree exactly.
  cell_key     text primary key,
  geom         geometry(Point, 4326) not null,
  radius_m     integer not null,
  -- The campsites themselves, already shaped for the client.
  sites        jsonb not null default '[]'::jsonb,
  found_count  integer not null default 0,
  fetched_at   timestamptz not null default now()
);

create index if not exists osm_campsite_sweeps_geom_idx
  on public.osm_campsite_sweeps using gist (geom);
create index if not exists osm_campsite_sweeps_fetched_idx
  on public.osm_campsite_sweeps (fetched_at);

comment on table public.osm_campsite_sweeps is
  'Cached OpenStreetMap campsite sweeps: which ground was swept, when, and what was found. A sweep older than 90 days is refreshed by the next camper to look at that ground.';

-- ---------------------------------------------------------------------
--  NOBODY BUT THE SERVER TOUCHES THIS.
--
--  RLS on with no policies at all: `service_role` bypasses RLS and every
--  other role is refused. A browser that could write here could claim a
--  patch of ground was already swept and empty of campsites, and make them
--  disappear for everybody for three months.
-- ---------------------------------------------------------------------

alter table public.osm_campsite_sweeps enable row level security;

revoke all on table public.osm_campsite_sweeps from public, anon, authenticated;
