-- ---------------------------------------------------------------------
--  MIGRATION 25 — A NOTE ON A FACILITY
--
--  Run after 24. Safe to re-run.
--
--  WHAT THIS IS FOR
--
--  A pin says a toilet is here. What it cannot say is the thing every
--  camper who has actually found one knows: it is round the back of the
--  yellow wall, the tap is the one on the left, the gate is locked after
--  six, the code is on the receipt. That knowledge has nowhere to live in
--  this schema. `pois.detail` is one field, written once by whoever
--  submitted the row, and there is no field at all on an OpenStreetMap
--  node — which is most of what the map draws.
--
--  So: notes. Short, attributed, and attached to EITHER a camper's `pois`
--  row or an OSM node id, because a note about a tap is worth keeping
--  whichever of the two put the tap on the screen. That is the whole
--  reason for the two nullable target columns and the check constraint
--  that insists on one of them.
--
--  WHAT A NOTE IS NOT
--
--  It is not a vote and it does not change a facility's standing. Saying
--  "it is behind the wall" is not saying "it is there" — a camper writing
--  directions from memory in a car park has not checked anything. The
--  ladder stays where it is, in `poi_votes` and `poi_lifecycle()`.
--
--  It is not a review either. There is no rating, no stars and no length
--  to write a paragraph in: 400 characters is a direction, not an essay,
--  and the cap is there so the card on the map stays readable.
--
--  WHAT IT DELIBERATELY DOES NOT DO
--
--  It does not hide a note until somebody agrees with it. A note is one
--  camper's words, attributed by handle, and reads as exactly that.
--  Hiding them until a quorum forms is how a feature that only works when
--  it is already popular never starts.
-- ---------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------
--  1. THE TABLE
--
--  `geom` is denormalised on purpose. A note attached to an OSM node has
--  no row of ours to join to for a position, and the map reads notes by
--  AREA — the same viewport question every other layer asks. Without a
--  position here that read would have to fetch every note in the country
--  and filter on the phone.
-- ---------------------------------------------------------------------

create table if not exists public.poi_notes (
  id          uuid primary key default gen_random_uuid(),
  poi_id      uuid references public.pois(id) on delete cascade,
  /* `osm-node-123456` — the same id the client draws the pin with. */
  osm_id      text,
  geom        geometry(Point, 4326) not null,
  body        text not null,
  author      uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),

  constraint poi_notes_target_ck
    check (poi_id is not null or osm_id is not null),
  constraint poi_notes_body_ck
    check (char_length(btrim(body)) between 2 and 400)
);

create index if not exists poi_notes_geom_idx on public.poi_notes using gist (geom);
create index if not exists poi_notes_poi_idx on public.poi_notes (poi_id);
create index if not exists poi_notes_osm_idx on public.poi_notes (osm_id);

/* One note per camper per facility. A second one is an edit, not a second
   opinion — see `add_poi_note`, which replaces rather than refuses. */
create unique index if not exists poi_notes_one_per_camper_poi
  on public.poi_notes (author, poi_id) where poi_id is not null;
create unique index if not exists poi_notes_one_per_camper_osm
  on public.poi_notes (author, osm_id) where osm_id is not null;


-- ---------------------------------------------------------------------
--  2. ROW LEVEL SECURITY
--
--  Readable by anybody, including signed-out campers: a note about where
--  the tap is is the kind of thing somebody with no account most needs.
--  Writable only as yourself, and deletable only by yourself.
-- ---------------------------------------------------------------------

alter table public.poi_notes enable row level security;

drop policy if exists poi_notes_read on public.poi_notes;
create policy poi_notes_read on public.poi_notes
  for select using (true);

drop policy if exists poi_notes_write_own on public.poi_notes;
create policy poi_notes_write_own on public.poi_notes
  for insert with check (author = auth.uid());

drop policy if exists poi_notes_delete_own on public.poi_notes;
create policy poi_notes_delete_own on public.poi_notes
  for delete using (author = auth.uid());


-- ---------------------------------------------------------------------
--  3. WRITE
--
--  SECURITY DEFINER because it has to read `profiles` for the handle it
--  echoes back, and because the daily cap has to be countable by the
--  function rather than by the caller.
--
--  A second note from the same camper about the same facility REPLACES
--  the first. Somebody correcting "behind the wall" to "behind the wall,
--  door on the left" is editing, and a map that shows both versions of
--  one person's directions is a map arguing with itself.
-- ---------------------------------------------------------------------

create or replace function public.add_poi_note(
  in_poi_id uuid,
  in_osm_id text,
  in_lat    double precision,
  in_lon    double precision,
  in_body   text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller  uuid := auth.uid();
  clean   text := btrim(coalesce(in_body, ''));
  today   integer;
  note_id uuid;
begin
  if caller is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to leave a note.');
  end if;

  if in_poi_id is null and nullif(btrim(coalesce(in_osm_id, '')), '') is null then
    return jsonb_build_object('ok', false, 'message', 'That note has nothing to attach to.');
  end if;

  if char_length(clean) < 2 then
    return jsonb_build_object('ok', false, 'message', 'Write a few words first.');
  end if;

  if char_length(clean) > 400 then
    return jsonb_build_object(
      'ok', false,
      'message', 'That is longer than a note — 400 characters is the room there is.'
    );
  end if;

  if in_lat is null or in_lon is null
     or in_lat not between -90 and 90 or in_lon not between -180 and 180 then
    return jsonb_build_object('ok', false, 'message', 'That location does not look right.');
  end if;

  /* A cap, because an account posting fifty notes an hour is not a camper.
     Twenty is far past anything a real trip produces. */
  select count(*) into today
  from public.poi_notes
  where author = caller and created_at > now() - interval '24 hours';

  if today >= 20 then
    return jsonb_build_object(
      'ok', false,
      'message', 'That is a lot of notes for one day. Try again tomorrow.'
    );
  end if;

  /*
    One statement per target, because `on conflict` can only name one index
    and these are two partial ones. Branching here is also the honest read of
    what is happening: a note is about a camper's row or about an OSM node,
    never about both, and the check constraint says so.
  */
  if in_poi_id is not null then
    insert into public.poi_notes (poi_id, osm_id, geom, body, author)
    values (
      in_poi_id, null,
      st_setsrid(st_makepoint(in_lon, in_lat), 4326), clean, caller
    )
    on conflict (author, poi_id) where poi_id is not null
    do update set body = excluded.body, created_at = now()
    returning id into note_id;
  else
    insert into public.poi_notes (poi_id, osm_id, geom, body, author)
    values (
      null, nullif(btrim(coalesce(in_osm_id, '')), ''),
      st_setsrid(st_makepoint(in_lon, in_lat), 4326), clean, caller
    )
    on conflict (author, osm_id) where osm_id is not null
    do update set body = excluded.body, created_at = now()
    returning id into note_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', note_id,
    'message', 'Note added. Other campers will see it on this pin.'
  );
end;
$$;

comment on function public.add_poi_note(uuid, text, double precision, double precision, text) is
  'Leaves one camper''s note on a facility — a camper POI or an OSM node. A second note from the same camper about the same facility replaces the first.';

revoke execute on function public.add_poi_note(uuid, text, double precision, double precision, text)
  from public, anon, authenticated;
grant execute on function public.add_poi_note(uuid, text, double precision, double precision, text)
  to authenticated;


-- ---------------------------------------------------------------------
--  4. READ
--
--  By area, like every other geometry read in this schema, and projected
--  server-side: `geom` over PostgREST is EWKB hex, which is the bug
--  migrations 09 and 15 were both written to fix.
--
--  Readable by `anon` on purpose — see the RLS note above.
-- ---------------------------------------------------------------------

create or replace function public.poi_notes_near(
  in_lat       double precision,
  in_lon       double precision,
  in_radius_km double precision default 25
)
returns table (
  id          uuid,
  poi_id      uuid,
  osm_id      text,
  body        text,
  author      uuid,
  author_name text,
  created_at  timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    n.id,
    n.poi_id,
    n.osm_id,
    n.body,
    n.author,
    coalesce(p.display_name, p.handle, 'A camper') as author_name,
    n.created_at
  from public.poi_notes n
  left join public.profiles p on p.id = n.author
  where st_dwithin(
    n.geom::geography,
    st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography,
    least(greatest(coalesce(in_radius_km, 25), 0.1), 200) * 1000
  )
  order by n.created_at desc
  limit 500;
$$;

comment on function public.poi_notes_near(double precision, double precision, double precision) is
  'Camper notes on facilities near a point, for the map layer. Signed-out campers can read them.';

revoke execute on function public.poi_notes_near(double precision, double precision, double precision)
  from public, anon, authenticated;
grant execute on function public.poi_notes_near(double precision, double precision, double precision)
  to anon, authenticated;

commit;

-- ---------------------------------------------------------------------
--  POST-INSTALL
--
--  Nothing to run. The layer picks notes up on its next viewport read.
-- ---------------------------------------------------------------------
