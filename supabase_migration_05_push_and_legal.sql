-- =====================================================================
--  Wandrlust — Migration 05: Push notifications & legal acceptance
--
--  Run AFTER migration 04. Additive.
--
--  Two things here:
--
--  1. PUSH. Device subscriptions, a delivery queue, and the geographic
--     matcher that decides who actually gets alerted. The matcher is in
--     SQL rather than application code because it is a spatial join —
--     PostGIS does it in one query, the app would do it in N.
--
--  2. LEGAL. Versioned document acceptance. If you change the terms you
--     need to know who agreed to WHICH version, and a boolean column
--     cannot tell you that.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------
drop type if exists public.notification_status cascade;
drop type if exists public.legal_doc_kind      cascade;

create type public.notification_status as enum (
  'pending', 'sent', 'failed', 'skipped', 'cancelled'
);

create type public.legal_doc_kind as enum (
  'privacy_policy', 'terms_of_service', 'safety_disclaimer'
);

-- ---------------------------------------------------------------------
-- 2. Device subscriptions
-- ---------------------------------------------------------------------
create table public.push_subscriptions (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,

  -- The endpoint IS the identity of a subscription; browsers rotate it.
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,

  user_agent    text,
  failure_count integer not null default 0,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),

  constraint push_subscriptions_failure_sane check (failure_count between 0 and 100)
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

comment on table public.push_subscriptions is
  'One row per browser/device. Rows are deleted on 404/410 from the push service, or after 5 consecutive failures.';

-- ---------------------------------------------------------------------
-- 3. Delivery queue
--
--    Queue-driven rather than fire-and-forget: a push provider outage
--    delays alerts instead of losing them, and we keep an audit trail of
--    what was sent. You want that the first time someone says they never
--    received a fire warning.
-- ---------------------------------------------------------------------
create table public.notification_queue (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,

  family        text not null,          -- fire | flood | storm | zone_heat | booking | hazard
  title         text not null,
  body          text not null,
  url           text default '/',
  tag           text,
  lat           double precision,
  lon           double precision,

  -- Higher goes out first. Fire and flood outrank booking updates.
  priority      smallint not null default 1,

  status        public.notification_status not null default 'pending',
  scheduled_for timestamptz not null default now(),
  processed_at  timestamptz,
  note          text,

  -- Prevents the same alert being queued twice for one user.
  dedupe_key    text,
  created_at    timestamptz not null default now(),

  constraint notification_queue_priority_range check (priority between 0 and 5)
);

create index notification_queue_pending_idx
  on public.notification_queue (status, scheduled_for, priority desc)
  where status = 'pending';

create unique index notification_queue_dedupe_idx
  on public.notification_queue (user_id, dedupe_key)
  where dedupe_key is not null;

-- ---------------------------------------------------------------------
-- 4. Alert targeting location
--
--    Rounded to ~1 km on the client before it is ever sent. Enough to
--    answer "is this fire warning near you", useless for tracking.
-- ---------------------------------------------------------------------
alter table public.user_settings
  add column if not exists alert_lat double precision,
  add column if not exists alert_lon double precision,
  add column if not exists alert_location_updated_at timestamptz,
  add column if not exists quiet_hours_start smallint,
  add column if not exists quiet_hours_end   smallint,
  add column if not exists push_enabled boolean not null default false;

comment on column public.user_settings.alert_lat is
  'Coarse location for alert targeting, rounded to ~1 km client-side. Not a location history.';

/**
 * Respect quiet hours, but never for life-safety alerts.
 *
 * A tornado warning at 3am is exactly the notification you want at 3am.
 * Booking updates are not.
 */
create or replace function public.in_quiet_hours(
  in_settings public.user_settings,
  in_family text
)
returns boolean
language plpgsql
immutable
as $$
declare
  hr integer := extract(hour from now())::integer;
begin
  -- Life-safety families always break through.
  if in_family in ('fire', 'flood', 'storm') then
    return false;
  end if;

  if in_settings.quiet_hours_start is null or in_settings.quiet_hours_end is null then
    return false;
  end if;

  -- Window may wrap midnight.
  if in_settings.quiet_hours_start <= in_settings.quiet_hours_end then
    return hr >= in_settings.quiet_hours_start and hr < in_settings.quiet_hours_end;
  else
    return hr >= in_settings.quiet_hours_start or hr < in_settings.quiet_hours_end;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. The matcher
--
--    One spatial join finds everyone whose alert location falls inside a
--    live weather alert polygon (or within their radius of its centroid),
--    who has that family enabled, and who hasn't already been queued for
--    that alert.
-- ---------------------------------------------------------------------
create or replace function public.queue_weather_alerts()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  queued integer := 0;
begin
  insert into public.notification_queue
    (user_id, family, title, body, url, tag, lat, lon, priority, dedupe_key)
  select
    s.user_id,
    w.family::text,
    w.event,
    left(coalesce(w.headline, w.event), 220),
    '/',
    'wx-' || w.id,
    st_y(st_centroid(w.geom)),
    st_x(st_centroid(w.geom)),
    case w.severity
      when 'extreme' then 5
      when 'severe'  then 4
      when 'moderate' then 2
      else 1
    end,
    'wx-' || w.id
  from public.weather_alerts w
  join public.user_settings s
    on  s.push_enabled
    and s.alert_lat is not null
    and s.alert_lon is not null
    -- Family must be enabled by the user.
    and (
      (w.family = 'fire'  and s.notify_fire_alerts)  or
      (w.family = 'flood' and s.notify_flood_alerts) or
      (w.family in ('storm','winter','heat','wind') and s.notify_storm_alerts)
    )
    -- Inside the alert polygon, or within the user's radius of its centre.
    and (
      (w.geom is not null and st_intersects(
          w.geom, st_setsrid(st_makepoint(s.alert_lon, s.alert_lat), 4326)))
      or
      (w.geom is not null and st_dwithin(
          st_centroid(w.geom)::geography,
          st_setsrid(st_makepoint(s.alert_lon, s.alert_lat), 4326)::geography,
          s.alert_radius_km * 1000))
    )
  where (w.expires is null or w.expires > now())
    -- Only alerts that actually warrant interrupting someone.
    and w.severity in ('extreme', 'severe', 'moderate')
    -- Stale location means we don't know where they are any more.
    and s.alert_location_updated_at > now() - interval '7 days'
    and not public.in_quiet_hours(s, w.family::text)
  on conflict do nothing;

  get diagnostics queued = row_count;
  return queued;
end;
$$;

/** Zone heat alerts — community-reported problems in an area. */
create or replace function public.queue_zone_alerts()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  queued integer := 0;
begin
  insert into public.notification_queue
    (user_id, family, title, body, url, tag, lat, lon, priority, dedupe_key)
  select
    s.user_id,
    'zone_heat',
    'Heads up in your area',
    'Several campers have reported ' || replace(z.reason::text, '_', ' ')
      || ' nearby. Check before you commit to a spot.',
    '/',
    'zone-' || z.id,
    st_y(z.centre),
    st_x(z.centre),
    2,
    'zone-' || z.id
  from public.zone_alerts z
  join public.user_settings s
    on  s.push_enabled
    and s.notify_zone_heat
    and s.alert_lat is not null
    and st_dwithin(
          z.centre::geography,
          st_setsrid(st_makepoint(s.alert_lon, s.alert_lat), 4326)::geography,
          least(s.alert_radius_km, 150) * 1000)
  where z.active_until > now()
    and s.alert_location_updated_at > now() - interval '7 days'
    and not public.in_quiet_hours(s, 'zone_heat')
  on conflict do nothing;

  get diagnostics queued = row_count;
  return queued;
end;
$$;

/** Booking status changes notify the other party. */
create or replace function public.queue_booking_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target uuid;
  msg    text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- Notify whichever side did NOT make the change.
  target := case when new.status in ('confirmed','cancelled') then new.guest_id else new.host_id end;

  msg := case new.status
    when 'confirmed' then 'Your stay was confirmed.'
    when 'cancelled' then 'Your booking was cancelled.'
    when 'completed' then 'Stay complete — leave a review to release both reviews and earn the bonus.'
    else 'Your booking status changed to ' || new.status::text || '.'
  end;

  insert into public.notification_queue
    (user_id, family, title, body, url, tag, priority, dedupe_key)
  select target, 'booking', 'Booking update', msg, '/', 'booking-' || new.id, 1,
         'booking-' || new.id || '-' || new.status::text
  from public.user_settings s
  where s.user_id = target
    and s.push_enabled
    and s.notify_booking_updates
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists bookings_notify on public.bookings;
create trigger bookings_notify
  after update of status on public.bookings
  for each row execute function public.queue_booking_notification();

/** Housekeeping: drop processed rows so the queue doesn't grow forever. */
create or replace function public.purge_notification_queue()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare n integer;
begin
  delete from public.notification_queue
   where status <> 'pending'
     and processed_at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Legal document acceptance
--
--    Versioned. When the documents change you need to know who accepted
--    WHICH version — a boolean can't answer that, and "everyone accepted
--    the terms" stops being true the moment you edit them.
-- ---------------------------------------------------------------------
create table public.legal_documents (
  id           bigint generated always as identity primary key,
  kind         public.legal_doc_kind not null,
  version      text not null,
  effective_on date not null default current_date,
  summary      text,
  body         text,
  is_current   boolean not null default true,

  constraint legal_documents_unique unique (kind, version)
);

create unique index legal_documents_one_current_idx
  on public.legal_documents (kind) where is_current;

create table public.legal_acceptances (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  document_id   bigint not null references public.legal_documents(id) on delete cascade,
  accepted_at   timestamptz not null default now(),
  -- Evidence of acceptance. Keep it minimal: enough to show consent, not a
  -- behavioural profile.
  user_agent    text,

  constraint legal_acceptances_unique unique (user_id, document_id)
);

create index legal_acceptances_user_idx on public.legal_acceptances (user_id);

insert into public.legal_documents (kind, version, summary) values
  ('privacy_policy', '1.0',
   'We store your name, username, email, password (hashed) and location. We never sell or share it with third parties.'),
  ('terms_of_service', '1.0',
   'Wandrlust is a planning tool, not a safety service. You are responsible for your own safety and for verifying land access.'),
  ('safety_disclaimer', '1.0',
   'Boundary data is approximate and not survey-grade. Conditions change. Never rely on this app alone for safety decisions.')
on conflict (kind, version) do nothing;

/** Which current documents has this user NOT yet accepted? */
create or replace function public.pending_legal_documents(in_user uuid)
returns table (
  document_id bigint,
  kind        public.legal_doc_kind,
  version     text,
  summary     text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.kind, d.version, d.summary
  from public.legal_documents d
  where d.is_current
    and not exists (
      select 1 from public.legal_acceptances a
      where a.user_id = in_user and a.document_id = d.id
    );
$$;

create or replace function public.accept_legal_documents(in_user_agent text default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  n integer;
begin
  if caller is null then
    raise exception 'authentication required';
  end if;

  insert into public.legal_acceptances (user_id, document_id, user_agent)
  select caller, d.id, left(coalesce(in_user_agent, ''), 300)
  from public.legal_documents d
  where d.is_current
  on conflict (user_id, document_id) do nothing;

  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. RLS
-- ---------------------------------------------------------------------
alter table public.push_subscriptions  enable row level security;
alter table public.notification_queue  enable row level security;
alter table public.legal_documents     enable row level security;
alter table public.legal_acceptances   enable row level security;

create policy "all: own push subscriptions" on public.push_subscriptions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Users may read their own notification history but never write it:
-- queueing is server-side only, or anyone could push to anyone.
create policy "read: own notifications" on public.notification_queue
  for select to authenticated using (user_id = auth.uid());

create policy "read: legal documents" on public.legal_documents
  for select to anon, authenticated using (true);

create policy "read: own acceptances" on public.legal_acceptances
  for select to authenticated using (user_id = auth.uid());

create policy "insert: own acceptance" on public.legal_acceptances
  for insert to authenticated with check (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select on public.notification_queue, public.legal_documents to authenticated;
grant select on public.legal_documents to anon;
grant select, insert on public.legal_acceptances to authenticated;

grant execute on function
  public.pending_legal_documents(uuid),
  public.accept_legal_documents(text)
  to authenticated;

revoke execute on function
  public.queue_weather_alerts(),
  public.queue_zone_alerts(),
  public.purge_notification_queue()
  from anon, authenticated;

commit;

-- =====================================================================
--  POST-INSTALL
--
--  1. Generate VAPID keys:
--       npm install web-push
--       npx tsx scripts/generateVapidKeys.ts
--
--  2. Schedule the matcher and dispatcher (pg_cron):
--       select cron.schedule('queue-weather', '*/10 * * * *',
--         $$select public.queue_weather_alerts()$$);
--       select cron.schedule('queue-zones', '*/30 * * * *',
--         $$select public.queue_zone_alerts()$$);
--       select cron.schedule('purge-queue', '0 4 * * *',
--         $$select public.purge_notification_queue()$$);
--
--     Then hit POST /api/push/dispatch every few minutes from your
--     scheduler of choice, with the x-dispatch-secret header.
--
--  3. Verify:
--       select status, count(*) from public.notification_queue group by 1;
--       select * from public.pending_legal_documents(auth.uid());
-- =====================================================================