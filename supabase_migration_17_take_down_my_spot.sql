-- ---------------------------------------------------------------------
--  MIGRATION 17 — TAKING BACK A SPOT YOU ADDED
--
--  Run after 16. Safe to re-run.
--
--  Until now a spot was a one-way door. Somebody adds a pullout from the
--  side of the road, gets home, realises it was somebody's driveway or that
--  they pinned the wrong bend — and there was nothing they could do about it.
--  The only route off the map was the takedown flow, which is built for
--  enforcement and turns the pin RED with a warning on it. Using that to
--  correct your own mistake tells every other camper that police moved
--  somebody on at a place where nothing happened.
--
--  So: ONE RULE, ON BOTH KINDS OF SPOT.
--
--    You may take down a spot you added, for as long as it is still only
--    yours. The moment anybody else reviews it, checks in at it, saves it,
--    photographs it or reports on it, it stops being yours to delete — it is
--    on their map too, and pulling it out from under them is not a correction,
--    it is a deletion of their work.
--
--  WHY A CAMPSITE IS DELETED AND A BEACON SPOT IS WITHDRAWN
--
--    A campsite has to be genuinely deleted. Migration 10's read policy is
--    `(is_published and not is_hidden) or submitted_by = auth.uid()`, so the
--    author keeps seeing their own row no matter what flag is set on it —
--    "remove" that leaves the pin sitting on the remover's own map is not a
--    remove. Nothing else references it that anybody would miss: the caller's
--    own check-ins, reviews, saves and photos cascade with it, and
--    content_reports deliberately has no foreign key so a report outlives
--    what it reported.
--
--    A beacon spot is withdrawn instead, exactly like the existing 'gone'
--    outcome. `beacon_spots_near` already filters `withdrawn_at is null`, so
--    the pin is just as gone from the map — and keeping the row means the
--    ~1 m dedupe index still holds and, more to the point, the six-new-spots
--    -a-day ceiling in `beacon_create_spot` still counts it. Hard-deleting
--    would hand anybody a loop: add a spot, collect the report points, delete
--    it, repeat, forever, invisibly.
--
--  NO POINTS ARE CLAWED BACK. A camper who adds a spot and then fixes their
--  own mistake did the right thing twice, and charging them for the second
--  one teaches them to leave the bad pin there instead.
-- ---------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------
--  1. CAN I TAKE THIS CAMPSITE DOWN, AND IF NOT, WHY NOT
--
--  Read on its own so the sheet can ask BEFORE it draws a button. A delete
--  button that turns out to be refused is worse than no button — the camper
--  has already decided the spot is gone by the time they read the error.
--
--  `exists: false` means there is no server row with this id at all, which is
--  the normal state of a spot added with no account or no signal. That copy
--  lives on the phone and only the phone, so the client removes it there and
--  does not need this function's permission.
-- ---------------------------------------------------------------------

create or replace function public.campsite_removal_state(in_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  caller  uuid := auth.uid();
  site    record;
  reviews integer := 0;
  visits  integer := 0;
  saves   integer := 0;
  photos  integer := 0;
  others  integer := 0;
  parts   text[] := array[]::text[];
  listed  text;
begin
  select c.id, c.submitted_by into site
    from public.campsites c
   where c.id = in_id;

  if not found then
    return jsonb_build_object(
      'exists', false, 'mine', false, 'removable', false,
      'others', 0, 'message', ''
    );
  end if;

  if caller is null or site.submitted_by is null or site.submitted_by <> caller then
    return jsonb_build_object(
      'exists', true, 'mine', false, 'removable', false,
      'others', 0, 'message', ''
    );
  end if;

  -- A review with no user_id is a legacy one from before migration 10 gave
  -- reviews an owner. It is somebody's, and it is not the caller's.
  select count(*) into reviews
    from public.campsite_reviews r
   where r.campsite_id = in_id
     and (r.user_id is null or r.user_id <> caller);

  select count(*) into visits
    from public.check_ins k
   where k.campsite_id = in_id
     and k.user_id <> caller;

  select count(*) into saves
    from public.saved_campsites s
   where s.campsite_id = in_id
     and s.user_id <> caller;

  select count(*) into photos
    from public.campsite_photos p
   where p.campsite_id = in_id
     and (p.user_id is null or p.user_id <> caller);

  others := reviews + visits + saves + photos;

  if others = 0 then
    return jsonb_build_object(
      'exists', true, 'mine', true, 'removable', true, 'others', 0,
      'message', 'Nobody else has touched this one, so it is still yours to take down.'
    );
  end if;

  if reviews > 0 then
    parts := parts || format('%s review%s', reviews, case when reviews = 1 then '' else 's' end);
  end if;
  if visits > 0 then
    parts := parts || format('%s check-in%s', visits, case when visits = 1 then '' else 's' end);
  end if;
  if saves > 0 then
    parts := parts || format('%s save%s', saves, case when saves = 1 then '' else 's' end);
  end if;
  if photos > 0 then
    parts := parts || format('%s photo%s', photos, case when photos = 1 then '' else 's' end);
  end if;

  -- "2 reviews, 1 check-in and 1 save" rather than "and and and".
  listed := case
    when array_length(parts, 1) = 1 then parts[1]
    else array_to_string(parts[1:array_length(parts, 1) - 1], ', ')
         || ' and ' || parts[array_length(parts, 1)]
  end;

  return jsonb_build_object(
    'exists', true, 'mine', true, 'removable', false, 'others', others,
    'message', format(
      'This spot has %s from other campers now. It is on their maps as well as yours, so it stays — report it instead if there is something wrong with it.',
      listed
    )
  );
end;
$$;

comment on function public.campsite_removal_state(text) is
  'Whether the caller may delete this campsite: theirs, and untouched by anybody else. Read before drawing the button, never after.';

grant execute on function public.campsite_removal_state(text) to anon, authenticated;


-- ---------------------------------------------------------------------
--  2. TAKE IT DOWN
--
--  Re-checks everything the state function checked. The client asking first
--  is a courtesy to the camper; this is the part that actually decides, and
--  it has to hold on its own against a caller that never asked.
-- ---------------------------------------------------------------------

create or replace function public.withdraw_my_campsite(in_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  state  jsonb;
begin
  state := public.campsite_removal_state(in_id);

  -- Never reached the server in the first place. Not an error, and checked
  -- BEFORE the sign-in check on purpose: a spot added with no account is
  -- exactly the spot that has no row here, and refusing to acknowledge that
  -- would trap the offline camper's own pin on their own phone forever.
  if not coalesce((state ->> 'exists')::boolean, false) then
    return jsonb_build_object('ok', true, 'removed', false,
      'message', 'That one only ever lived on your device.');
  end if;

  if caller is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to take down a spot you added.');
  end if;

  if not coalesce((state ->> 'mine')::boolean, false) then
    return jsonb_build_object('ok', false,
      'message', 'Only the camper who added a spot can take it down.');
  end if;

  if not coalesce((state ->> 'removable')::boolean, false) then
    return jsonb_build_object('ok', false, 'message', state ->> 'message');
  end if;

  -- check_ins, campsite_reviews, campsite_photos and saved_campsites all
  -- cascade from campsites.id, and by here every one of those rows is the
  -- caller's own. content_reports has no foreign key on purpose and outlives
  -- this, which is what lets a moderator still see what was reported.
  delete from public.campsites
   where id = in_id
     and submitted_by = caller;

  return jsonb_build_object('ok', true, 'removed', true,
    'message', 'Taken down. It is off the map.');
end;
$$;

comment on function public.withdraw_my_campsite(text) is
  'Delete a campsite you submitted, while nobody else has reviewed, visited, saved or photographed it. Refuses with a plain-English reason otherwise.';

-- anon as well as authenticated, for one reason: a camper who added a spot
-- while signed out has a pin with no server row behind it, and the only
-- branch they can reach is the "never reached the server" one above, which
-- deletes nothing. Without the grant, removing their own offline pin would
-- come back as a connection error and the pin would stay.
grant execute on function public.withdraw_my_campsite(text) to anon, authenticated;


-- ---------------------------------------------------------------------
--  3. THE SAME QUESTION ABOUT A BEACON SPOT
--
--  WHO ADDED A BEACON SPOT is not a column, and does not need to be.
--  `beacon_create_spot` files the creator's own report inside the same call
--  and deletes the spot outright if that report is refused, so on a spot with
--  generator = 'camper' the earliest accepted visit IS the creator. A spot
--  that merged into somebody else's pin never got created, so the caller is
--  correctly not its owner.
--
--  Scan-found leads are deliberately excluded. Nobody added those, so nobody
--  owns them, and one camper deciding a lead is rubbish is what the report
--  scales are for — it is not grounds to take a place off everybody's map.
-- ---------------------------------------------------------------------

create or replace function public.beacon_spot_removal_state(in_spot uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  caller    uuid := auth.uid();
  spot      record;
  founder   uuid;
  visitors  integer := 0;
  reports   integer := 0;
  vouches   integer := 0;
  others    integer := 0;
  mine      boolean := false;
begin
  select s.id, s.generator, s.withdrawn_at into spot
    from public.beacon_spots s
   where s.id = in_spot;

  if not found or spot.withdrawn_at is not null then
    return jsonb_build_object('exists', false, 'mine', false,
      'removable', false, 'others', 0, 'message', '');
  end if;

  if caller is null then
    return jsonb_build_object('exists', true, 'mine', false,
      'removable', false, 'others', 0, 'message', '');
  end if;

  select v.user_id into founder
    from public.beacon_visits v
   where v.spot_id = in_spot
     and v.accepted
   order by v.created_at asc
   limit 1;

  -- `founder is not null` is load-bearing. Without it a camper-generated spot
  -- carrying no accepted visit yields NULL rather than false, `not mine` is
  -- then NULL too, the guard below does not fire, and the function goes on to
  -- offer a spot nobody owns to whoever happened to open the sheet.
  mine := spot.generator = 'camper' and founder is not null and founder = caller;

  if mine is not true then
    return jsonb_build_object('exists', true, 'mine', false,
      'removable', false, 'others', 0, 'message', '');
  end if;

  select count(distinct v.user_id) into visitors
    from public.beacon_visits v
   where v.spot_id = in_spot and v.accepted and v.user_id <> caller;

  select count(distinct r.user_id) into reports
    from public.beacon_reports r
   where r.spot_id = in_spot and r.user_id <> caller;

  select count(distinct b.user_id) into vouches
    from public.beacon_verifications b
   where b.spot_id = in_spot and b.accepted and b.user_id <> caller;

  others := greatest(visitors, reports, vouches);

  if others = 0 then
    return jsonb_build_object('exists', true, 'mine', true, 'removable', true,
      'others', 0,
      'message', 'You put this one on the map and nobody else has been here, so it is still yours to take down.');
  end if;

  return jsonb_build_object('exists', true, 'mine', true, 'removable', false,
    'others', others,
    'message', format(
      '%s other camper%s reported on this spot since you added it, so it stays on the map. Use the buttons above if something went wrong here.',
      others, case when others = 1 then ' has' else 's have' end
    ));
end;
$$;

comment on function public.beacon_spot_removal_state(uuid) is
  'Whether the caller may take down this beacon spot: they created it and no other camper has reported on it. Scan-found leads are nobody''s to delete.';

grant execute on function public.beacon_spot_removal_state(uuid) to anon, authenticated;


-- ---------------------------------------------------------------------
--  4. TAKE THE BEACON SPOT DOWN
--
--  Withdrawn, not deleted — see the header. Off the map either way; the row
--  stays so the daily new-spot ceiling still counts it and the same pullout
--  cannot be re-added a metre away five minutes later.
--
--  This is NOT the knock path and must never be confused with it. It writes
--  no beacon_report, leaves knock_count alone and never touches the flagged
--  tier: a camper tidying up their own pin has not been moved on by anybody,
--  and recording it as enforcement would be a lie told to every camper who
--  reads the map afterwards.
-- ---------------------------------------------------------------------

create or replace function public.beacon_withdraw_my_spot(
  in_spot   uuid,
  in_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  state  jsonb;
  reason text := nullif(btrim(coalesce(in_reason, '')), '');
begin
  if caller is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to take down a spot you added.');
  end if;

  state := public.beacon_spot_removal_state(in_spot);

  if not coalesce((state ->> 'exists')::boolean, false) then
    return jsonb_build_object('ok', false, 'message', 'That spot is no longer on the map.');
  end if;

  if not coalesce((state ->> 'mine')::boolean, false) then
    return jsonb_build_object('ok', false,
      'message', 'Only the camper who added a spot can take it down.');
  end if;

  if not coalesce((state ->> 'removable')::boolean, false) then
    return jsonb_build_object('ok', false, 'message', state ->> 'message');
  end if;

  update public.beacon_spots
     set tier             = 'withdrawn',
         withdrawn_at     = now(),
         withdrawn_reason = coalesce(
           left(reason, 240),
           'The camper who added this spot took it back down.')
   where id = in_spot;

  return jsonb_build_object('ok', true, 'removed', true,
    'message', 'Taken down. It is off the map.');
end;
$$;

comment on function public.beacon_withdraw_my_spot(uuid, text) is
  'Withdraw a beacon spot you created while no other camper has reported on it. Not a knock: writes no report and never sets the flagged tier.';

grant execute on function public.beacon_withdraw_my_spot(uuid, text) to authenticated;

commit;
