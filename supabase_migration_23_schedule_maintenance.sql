-- =====================================================================
--  23. Actually schedule the maintenance six migrations asked for
--
--  WHAT WAS WRONG
--
--  Migrations 02, 04, 05 and 19 each end with a POST-INSTALL block naming
--  the pg_cron jobs they need, in copy-and-paste form:
--
--      select cron.schedule('purge-presence', '*/15 * * * *',
--        'select public.purge_expired_presence();');
--
--  Seven jobs across four files, every one of them a comment. (Six are
--  scheduled here; the seventh is dead, and migration 24 explains why.)
--  Nobody ran them, and nothing about the database says they are
--  missing — the
--  functions all exist, they simply never fire. `beacon_maintenance` was
--  the only one ever scheduled, and only because migration 13 put its
--  `cron.schedule` in the migration body rather than in a comment at the
--  bottom. That is the whole difference, and this file is the rest of them
--  moved to where migration 13 put its one.
--
--  WHAT IT COST
--
--  Nothing loud, which is why it lasted. Each of these is a slow leak
--  rather than a break:
--
--    purge_expired_presence   a camper who shared their position stays on
--                             other people's maps after their share has
--                             expired — the one job here with a privacy
--                             cost rather than a housekeeping one
--    purge_expired_alerts     expired weather warnings are never swept
--    purge_notification_queue delivered notifications accumulate forever
--    refresh_zone_alerts      the "several campers reported this" rollup
--                             never recomputes, so it stays empty
--    queue_weather_alerts     the matcher that turns a new warning into a
--                             notification for the people near it
--    queue_zone_alerts        the same for camper-reported zones
--    prune_boundary_tile_cache the tile cache grows without limit
--
--  The two queue_* matchers only have anything to do once weather alerts
--  are being ingested and somebody has a push subscription — neither is
--  true on this deployment yet. They are scheduled anyway, because the
--  failure mode being fixed here is precisely a correct job that nobody
--  ever turned on.
--
--  These run inside the database, so they need no keys, no external
--  scheduler and no deployment. Push DELIVERY still does — see
--  /api/push/dispatch, which wants a scheduler and VAPID keys.
-- =====================================================================

begin;

do $$
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron is not installed; skipping. Enable it and re-run this file.';
    return;
  end if;

  -- cron.schedule upserts on the job name, so re-running this file is safe
  -- and re-running it is how a changed schedule takes effect.

  -- Presence expires on a fifteen-minute granularity; sweeping it on the
  -- same period means a share is never visible much past its own end.
  perform cron.schedule('purge-presence', '*/15 * * * *',
    'select public.purge_expired_presence();');

  perform cron.schedule('purge-alerts', '0 * * * *',
    'select public.purge_expired_alerts();');

  perform cron.schedule('zone-alerts', '0 * * * *',
    'select public.refresh_zone_alerts();');

  -- 'release-reviews' is deliberately absent. It was in migration 04's
  -- POST-INSTALL list, but `release_stale_reviews()` updates a table that
  -- hosting took with it when it left, so the job could only ever have
  -- failed nightly. Migration 24 removes the function and the reasoning.

  -- The matchers. Weather moves faster than camper reports, hence the gap
  -- between the two periods; both are what migration 05 asked for.
  perform cron.schedule('queue-weather', '*/10 * * * *',
    'select public.queue_weather_alerts();');

  perform cron.schedule('queue-zones', '*/30 * * * *',
    'select public.queue_zone_alerts();');

  perform cron.schedule('purge-queue', '0 4 * * *',
    'select public.purge_notification_queue();');

  -- Defaults are 180 days and 20,000 rows. Weekly is plenty for a cache
  -- that only grows when somebody looks at new ground.
  perform cron.schedule('prune-tile-cache', '23 5 * * 0',
    'select public.prune_boundary_tile_cache();');
end $$;

commit;

-- =====================================================================
--  AFTERWARDS
--
--    select jobname, schedule, active from cron.job order by jobname;
--
--  Eight jobs: the seven above plus beacon-maintenance from migration 13.
--  What each run did:
--
--    select jobname, status, return_message, start_time
--    from cron.job_run_details order by start_time desc limit 20;
-- =====================================================================
