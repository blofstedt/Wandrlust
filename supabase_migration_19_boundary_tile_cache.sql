-- =====================================================================
--  19. BOUNDARY TILE CACHE
--
--  Stop asking eight government servers for land that has not moved.
--
--  BLM units, national forests and Crown land change on the order of an
--  act of legislature. The app was re-fetching them from ArcGIS on every
--  cold start, because the only cache was a Map in one Node process:
--  Vercel runs the API as a serverless function, so that Map is empty
--  again the moment a lambda is recycled, and the next camper to look at
--  Ontario waits on a provincial server that may or may not answer.
--
--  There IS a proper answer already in this schema — `public_lands`,
--  which `npm run seed` fills and `boundaries_in_bbox` reads first. It
--  has never been run against this database: `select count(*) from
--  public_lands` returns 0, so that whole path has never once fired and
--  every single request has gone to the live services. Seeding it is
--  still the better long-term answer and this does not replace it.
--
--  This is the cache that fills itself in the meantime. One row per
--  (source, bounding box, generalisation) — the exact question that was
--  asked upstream — holding the answer that came back. The second time
--  anyone looks at that ground, from any device, on any lambda, it is a
--  single indexed read instead of a round trip to Ontario.
--
--  WHAT IT IS NOT. Not a source of truth: nothing here is used to decide
--  whether land exists, only to avoid re-asking. A miss falls straight
--  through to the live services exactly as before, and a source that
--  failed is never written — caching a failure would hide real public
--  land for as long as the row lived, which is this app's worst failure.
-- =====================================================================

create table if not exists public.boundary_tile_cache (
  -- source id | bbox to 4dp | generalisation bucket | record cap.
  -- Everything that can change the answer is in the key; nothing that
  -- cannot is, so two campers looking at the same ground share a row.
  cache_key      text primary key,
  source_id      text        not null,
  -- The normalised GeoJSON features, exactly as the route would have
  -- built them. Postgres TOAST-compresses this; coordinate runs shrink
  -- by roughly ten to one.
  features       jsonb       not null,
  feature_count  integer     not null default 0,
  -- Carried through so a cached answer knows it was a partial one and
  -- the map can still say "largest areas only".
  truncated      boolean     not null default false,
  fetched_at     timestamptz not null default now()
);

-- Pruning walks oldest-first.
create index if not exists boundary_tile_cache_fetched_idx
  on public.boundary_tile_cache (fetched_at);

/*
 * LOCKED SHUT TO EVERYONE BUT THE SERVER.
 *
 * RLS on with no policies at all: the anon key — which is public by
 * design and shipped to every browser — can neither read nor write this
 * table. The API reaches it with the service role, which bypasses RLS,
 * and the service role never leaves the server. A cache anyone could
 * write to is a cache anyone could use to put polygons on other
 * people's maps.
 */
alter table public.boundary_tile_cache enable row level security;

comment on table public.boundary_tile_cache is
  'Cached upstream boundary responses. Not a source of truth — a miss falls through to the live services. Server-only: RLS is on with no policies.';

/*
 * Keep it bounded.
 *
 * Called occasionally by the API rather than on every write. Deletes
 * anything older than the retention window, then trims to a row cap
 * oldest-first, so a long tail of viewports nobody revisits cannot grow
 * without limit.
 */
create or replace function public.prune_boundary_tile_cache(
  in_max_age_days integer default 180,
  in_max_rows     integer default 20000
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer := 0;
  n       integer;
begin
  delete from public.boundary_tile_cache
   where fetched_at < now() - make_interval(days => greatest(in_max_age_days, 1));
  get diagnostics removed = row_count;

  delete from public.boundary_tile_cache
   where cache_key in (
     select cache_key
       from public.boundary_tile_cache
      order by fetched_at desc
      offset greatest(in_max_rows, 1000)
   );
  get diagnostics n = row_count;

  return removed + n;
end;
$$;

revoke all on function public.prune_boundary_tile_cache(integer, integer) from public, anon, authenticated;
