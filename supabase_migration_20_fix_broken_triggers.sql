-- =====================================================================
--  20. THE TWO TRIGGERS THAT HAVE BEEN THROWING SINCE MIGRATION 08
--
--  Migration 08 was the tokens -> points rename. It rewrote every
--  function that mentioned `grant_tokens`, `token_rules` or
--  `token_ledger`, and in two of them the rewrite also changed a column
--  reference to one that does not exist. Both are BEFORE/AFTER triggers,
--  so the error does not land in a log somewhere — it aborts the insert
--  that fired it, and the feature simply never works.
--
--  1. accept_telemetry_batch() checks `new.point_count`. There is no
--     `point_count` column on telemetry_batches; there never has been.
--     The original gate in migration 02 checked `dash_mounted` and
--     `mean_speed_kph`, which is what the client actually uploads
--     (see uploadTelemetryBatch in dataService.ts). Every Scout Mode
--     batch since has raised 42703 and been rejected by Postgres, so no
--     road-surface data has ever been stored and no telemetry points
--     have ever been paid.
--
--  2. reward_hazard_confirmation() selects `h.reporter_id` from
--     hazard_reports, which has `user_id`. Every attempt to confirm
--     somebody else's hazard report has raised 42703 and rolled back —
--     the confirmation itself, not just the bonus.
--
--  This migration restores the intended logic under the points names.
--  The gate is deliberately the migration 02 one, unchanged in meaning:
--  only a dash-mounted phone that was actually moving over at least
--  200 m of road earns anything, because that is the only movement
--  attributable to the road surface rather than to a pocket.
--
--  Also here, because it is the same class of bug: content_reports'
--  auto-hide trigger casts `target_id` straight to uuid, so a malformed
--  id raises a raw 22P02 out of a trigger body. It now ignores an id
--  that is not a uuid instead of failing the transaction.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. Telemetry acceptance gate
-- ---------------------------------------------------------------------
create or replace function public.accept_telemetry_batch()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare reward integer; cap integer; daily integer;
begin
  -- A phone in a pocket or a cup holder records the person, not the road.
  if not new.dash_mounted then
    new.accepted := false;
    new.reject_reason := 'phone not dash-mounted; movement not attributable to road surface';
    return new;
  end if;

  if coalesce(new.mean_speed_kph, 0) < 5 then
    new.accepted := false;
    new.reject_reason := 'stationary or near-stationary';
    return new;
  end if;

  if st_length(new.path::geography) < 200 then
    new.accepted := false;
    new.reject_reason := 'path shorter than 200 m';
    return new;
  end if;

  new.accepted := true;

  select amount, daily_cap into reward, cap
  from public.points_rules where reason = 'telemetry_batch';

  select count(*) into daily
  from public.points_ledger
  where user_id = new.user_id
    and reason = 'telemetry_batch'
    and created_at > now() - interval '24 hours';

  if cap is null or daily < cap then
    perform public.grant_points(new.user_id, coalesce(reward, 5), 'telemetry_batch',
                                'telemetry_batches', new.id::text);
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
--  2. Hazard confirmation bonus
-- ---------------------------------------------------------------------
create or replace function public.reward_hazard_confirmation()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare confirmations integer; reporter uuid;
begin
  select count(*), max(h.user_id) into confirmations, reporter
  from public.hazard_confirmations hc
  join public.hazard_reports h on h.id = hc.hazard_id
  where hc.hazard_id = new.hazard_id;

  if confirmations = 3 and reporter is not null then
    perform public.grant_points(
      reporter,
      (select amount from public.points_rules where reason = 'early_hazard_bonus'),
      'early_hazard_bonus', 'hazard_reports', new.hazard_id::text
    );
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
--  3. Auto-hide trigger: a bad id is ignored, not raised
-- ---------------------------------------------------------------------
create or replace function public.auto_hide_reported_content()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reporters integer;
  target_uuid uuid;
begin
  select count(distinct reporter_id) into reporters
    from public.content_reports
   where target_kind = new.target_kind
     and target_id   = new.target_id
     and resolved_at is null;

  if reporters < 3 then
    return null;
  end if;

  if new.target_kind = 'campsite' then
    update public.campsites set is_hidden = true where id = new.target_id;
    return null;
  end if;

  -- Reviews and photos are keyed by uuid. A target_id that is not one
  -- cannot match anything, and casting it would abort the insert with a
  -- raw 22P02 from inside a trigger body.
  if new.target_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  target_uuid := new.target_id::uuid;

  if new.target_kind = 'campsite_review' then
    update public.campsite_reviews set is_hidden = true where id = target_uuid;
    -- Recompute the average without the review just hidden.
    update public.campsites c
       set rating = coalesce((
             select round(avg(r.rating)::numeric, 1) from public.campsite_reviews r
              where r.campsite_id = c.id and not r.is_hidden), 0),
           review_count = (
             select count(*) from public.campsite_reviews r
              where r.campsite_id = c.id and not r.is_hidden)
     where c.id = (select campsite_id from public.campsite_reviews where id = target_uuid);
  elsif new.target_kind = 'campsite_photo' then
    update public.campsite_photos set is_hidden = true where id = target_uuid;
  end if;

  return null;
end;
$$;
