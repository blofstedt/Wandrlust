-- ---------------------------------------------------------------------
--  MIGRATION 15 — FACILITIES ON THE MAP
--
--  Run after 14. Safe to re-run.
--
--  WHAT WAS WRONG
--
--  Migration 02 built a whole facilities feature and nothing ever used it.
--  The `pois` table, the `poi_kind` enum, the `poi_votes` table, the
--  promote-at-five `poi_lifecycle()` trigger and a 25-point `poi_submit`
--  reward have all been sitting there since the beginning. The table has
--  zero rows, and that is what the flow earned: the only way in was a tab
--  called "Add a POI" buried in the Report panel, which dropped the pin at
--  whatever the map happened to be centred on, demanded a name for a pit
--  toilet that has not got one, and then never drew it anywhere.
--
--  Three things fix that here.
--
--  ONE: `pois_near()`, BECAUSE THE CLIENT READ COULD NEVER HAVE WORKED.
--  `fetchPois` did `select *` on a PostGIS `geom`, so PostgREST handed the
--  app EWKB hex — '0101000020E6100000...' — where it expected two numbers.
--  This is precisely the bug migration 09 was written to fix for
--  `hazard_reports`, and its header said it out loud: "Nothing rendered it
--  before, so nothing broke; the moment a map layer consumes it, it would."
--  A map layer is about to consume it. Every other geometry read in this
--  schema goes through an RPC that projects server-side and filters by
--  distance in the database rather than shipping the country to a phone.
--
--  TWO: A TOILET IS NOW A THING YOU CAN ADD. `poi_kind` has ten values and
--  not one of them is a toilet — the single most-hunted facility there is
--  was literally unrepresentable. Campers could log an air compressor and
--  not a vault toilet.
--
--  THREE: THE REWARD ACTUALLY PAYS. `points_rules` has carried
--  ('poi_submit', 25, cap 2) since migration 02 and nothing has ever called
--  `grant_points` with it, because the client wrote to the table directly.
--  `submit_poi()` is SECURITY DEFINER and does it properly, applying the
--  daily cap the way migration 08 lays out rather than the uncapped
--  shortcut `beacon_submit_visit` took.
--
--  WHAT THIS DELIBERATELY DOES NOT DO
--
--  It does not hide a new facility until five people upvote it. That rule
--  still governs `status`, and `status` still means what it meant — but the
--  READ returns pending rows too, and the map draws them hollow with "one
--  camper added this, nobody else has confirmed it" written on them. A
--  facility nobody can see is a facility nobody can ever confirm, and five
--  net votes is a number this app would not reach for years.
--
--  It does not turn an empty result into a fact. `pois_near` returning
--  nothing means nobody has recorded a toilet there. The client says that in
--  those words and never "there is no toilet here".
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
--  0. NEW ENUM VALUE
--
--  Postgres will not let a new enum value be USED in the transaction that
--  created it, so this runs on its own, before the main transaction.
-- ---------------------------------------------------------------------

alter type public.poi_kind add value if not exists 'toilet';


begin;

-- ---------------------------------------------------------------------
--  1. STOP THE SAME TAP LANDING TWICE
--
--  ~1 m, and scoped to the kind. Two campers logging the same vault toilet
--  from opposite ends of the car park still make two rows, and that is
--  CORRECT — the client merges them for display and never deletes either,
--  because two pullouts 80 m apart really can both have a toilet and hiding
--  one is the failure that matters. This index only catches the double-tap:
--  the same kind, at the same coordinate, twice.
-- ---------------------------------------------------------------------

create unique index if not exists pois_dedupe_idx on public.pois (
  kind,
  round(st_y(geom)::numeric, 5),
  round(st_x(geom)::numeric, 5)
);


-- ---------------------------------------------------------------------
--  1b. A FACILITY MAY HAVE NO NAME
--
--  `name` was `not null` from migration 02, which is the constraint that
--  forced the old form to demand one. A vault toilet on a forest road has
--  not got a name, so the only ways past it were to invent something — a
--  made-up name is a claim about a place, and this app does not make those
--  — or to give up. Most campers gave up.
--
--  Null now means "it has no name", and the client falls back to the kind.
-- ---------------------------------------------------------------------

alter table public.pois alter column name drop not null;


-- ---------------------------------------------------------------------
--  2. READ: EVERY FACILITY NEAR A POINT, PROJECTED TO LAT/LON
--
--  Written the same way as beacon_spots_near and hazards_near: radius
--  clamped, capped row count, distance filtered in the database.
--
--  Reporter identity is not returned. A facility stands on its
--  confirmations, and who logged it is nobody's business on a map.
-- ---------------------------------------------------------------------

create or replace function public.pois_near(
  in_lat       double precision,
  in_lon       double precision,
  in_radius_km double precision default 25
)
returns table (
  id            uuid,
  kind          public.poi_kind,
  name          text,
  detail        text,
  latitude      double precision,
  longitude     double precision,
  is_free       boolean,
  price_cents   integer,
  status        public.poi_status,
  upvotes       integer,
  downvotes     integer,
  created_at    timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id, p.kind, p.name, p.detail,
    st_y(p.geom), st_x(p.geom),
    p.is_free, p.price_cents, p.status,
    p.upvotes, p.downvotes, p.created_at
  from public.pois p
  where p.status <> 'pruned'
    and st_dwithin(
          p.geom::geography,
          st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography,
          least(coalesce(in_radius_km, 25), 200) * 1000
        )
  -- Best-attested first, so a capped result keeps the confirmed ones.
  order by (p.upvotes - p.downvotes) desc, p.created_at desc
  limit 200;
$$;

comment on function public.pois_near(double precision, double precision, double precision) is
  'Facilities near a point, projected to lat/lon. Includes pending rows: the client draws those hollow and says nobody has confirmed them. An empty result means nobody has recorded one, never that there is none.';

grant execute on function public.pois_near(double precision, double precision, double precision)
  to anon, authenticated;


-- ---------------------------------------------------------------------
--  3. WRITE: ADD A FACILITY
--
--  Returns a jsonb envelope rather than raising, so a rejection reaches the
--  camper as a sentence instead of a Postgres error code.
--
--  The name is OPTIONAL and that is the point. Most pit toilets have no
--  name, and the old form demanded one — so the honest answer was to type
--  something made up, or give up. Null here, and the client shows the kind.
-- ---------------------------------------------------------------------

create or replace function public.submit_poi(
  in_kind   public.poi_kind,
  in_lat    double precision,
  in_lon    double precision,
  in_name   text default null,
  in_detail text default null,
  in_free   boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller  uuid := auth.uid();
  new_id  uuid;
  reward  integer;
  cap     integer;
  daily   integer;
begin
  if caller is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to add a facility.');
  end if;

  if in_lat is null or in_lon is null
     or in_lat not between -90 and 90 or in_lon not between -180 and 180 then
    return jsonb_build_object('ok', false, 'message', 'That location does not look right.');
  end if;

  insert into public.pois (kind, name, geom, detail, is_free, submitted_by, status)
  values (
    in_kind,
    nullif(btrim(coalesce(in_name, '')), ''),
    st_setsrid(st_makepoint(in_lon, in_lat), 4326),
    nullif(btrim(coalesce(in_detail, '')), ''),
    in_free,
    caller,
    'pending'
  )
  on conflict do nothing
  returning id into new_id;

  -- The dedupe index caught it: this exact kind is already at this exact
  -- spot. Not an error, and not worth a second row — say so plainly.
  if new_id is null then
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'message', 'That one is already on the map.'
    );
  end if;

  -- Points, with the cap applied here rather than inside grant_points,
  -- which is a dumb ledger insert by design. See migration 08.
  select amount, daily_cap into reward, cap
  from public.points_rules where reason = 'poi_submit';

  select count(*) into daily
  from public.points_ledger
  where user_id = caller
    and reason = 'poi_submit'
    and created_at > now() - interval '24 hours';

  if cap is null or daily < cap then
    perform public.grant_points(caller, coalesce(reward, 25), 'poi_submit',
                                'pois', new_id::text, 'Added a facility');
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', new_id,
    'duplicate', false,
    'message', 'Added. It shows on the map straight away, marked as unconfirmed until somebody else agrees.'
  );
end;
$$;

comment on function public.submit_poi(public.poi_kind, double precision, double precision, text, text, boolean) is
  'Adds a camper-reported facility and grants the capped poi_submit reward. Name is optional; most pit toilets have not got one.';

grant execute on function public.submit_poi(public.poi_kind, double precision, double precision, text, text, boolean)
  to authenticated;


-- ---------------------------------------------------------------------
--  4. WRITE: CONFIRM ONE, OR SAY IT IS GONE
--
--  This is what makes poi_lifecycle() fire for the first time. Without it
--  nothing ever left 'pending' and nothing was ever pruned — the trigger
--  has been armed and unreachable since migration 02.
--
--  One vote per camper per facility, enforced by poi_votes' primary key.
--  A second one is not an error; it is somebody tapping twice.
-- ---------------------------------------------------------------------

create or replace function public.vote_poi(
  in_poi_id uuid,
  in_upvote boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller  uuid := auth.uid();
  exists_ boolean;
begin
  if caller is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to confirm a facility.');
  end if;

  select true into exists_ from public.pois where id = in_poi_id;
  if exists_ is null then
    return jsonb_build_object('ok', false, 'message', 'That facility is no longer on the map.');
  end if;

  insert into public.poi_votes (poi_id, user_id, is_upvote)
  values (in_poi_id, caller, in_upvote)
  on conflict (poi_id, user_id) do nothing;

  if not found then
    return jsonb_build_object('ok', false, 'message', 'You have already had your say on this one.');
  end if;

  return jsonb_build_object(
    'ok', true,
    'message', case when in_upvote
      then 'Thanks — confirmed.'
      else 'Noted. If others say the same it comes off the map.'
    end
  );
end;
$$;

comment on function public.vote_poi(uuid, boolean) is
  'One confirmation or contradiction per camper per facility. Fires poi_lifecycle(), which promotes at +5 net and prunes after 3 consecutive downvotes.';

grant execute on function public.vote_poi(uuid, boolean) to authenticated;


-- ---------------------------------------------------------------------
--  5. THE POINTS RULE, RESTATED
--
--  Already inserted by migration 02. Restated so a database seeded from a
--  later baseline still has it, and so the description matches what the
--  feature is now actually called in the UI — "facility", not "POI".
-- ---------------------------------------------------------------------

insert into public.points_rules (reason, amount, daily_cap, description)
values ('poi_submit', 25, 2, 'Added a facility other campers can use')
on conflict (reason) do update
  set amount = excluded.amount,
      daily_cap = excluded.daily_cap,
      description = excluded.description;


-- ---------------------------------------------------------------------
--  6. ROW LEVEL SECURITY
--
--  The read policy from migration 02 already allows anon to see anything
--  not pruned, which is what the hollow-pin design needs, so it is left
--  alone. The direct-insert policy is dropped: writes now go through
--  submit_poi, which is SECURITY DEFINER and is the only thing that can
--  grant points. Leaving a direct insert open would mean a client could
--  add a facility and silently skip its own reward.
-- ---------------------------------------------------------------------

do $$ begin
  drop policy if exists "insert: own POI" on public.pois;
exception when undefined_object then null;
end $$;

grant select on public.pois to anon, authenticated;
grant select on public.poi_votes to authenticated;

commit;
