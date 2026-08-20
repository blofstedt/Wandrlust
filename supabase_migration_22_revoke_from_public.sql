-- =====================================================================
--  22. Take the private functions back off the public internet
--
--  WHAT WAS WRONG
--
--  Six earlier migrations locked their maintenance and points functions
--  away with a line that reads exactly right and does nothing:
--
--      revoke execute on function public.grant_points(...) from anon, authenticated;
--
--  In PostgreSQL a newly created function carries an implicit
--  `GRANT EXECUTE TO PUBLIC`. `anon` and `authenticated` are members of
--  PUBLIC, so revoking the privilege they were never separately granted
--  leaves the inherited one untouched and the function still callable.
--  The ACL says so plainly once you know to look — the leading `=X/postgres`
--  in `{=X/postgres,postgres=X/postgres,service_role=X/postgres}` IS the
--  PUBLIC grant, sitting there after the revoke ran:
--
--      grant_points  {=X/postgres,postgres=X/postgres,service_role=X/postgres}
--
--  Every one of these functions is `security definer`, and PostgREST
--  publishes everything in `public` at /rest/v1/rpc/<name>. The anon key is
--  public by design — it ships in the JavaScript bundle. So the net effect
--  was that anyone at all could POST to
--
--      /rest/v1/rpc/grant_points  {"in_user":"<any uuid>","in_amount":1000000,...}
--
--  and mint themselves an unlimited points balance, which buys stealth-site
--  reveals and beacon tokens and moves trust tiers. Verified on the live
--  database before this migration: called as `anon`, `grant_points` was not
--  refused — it reached its own body and failed on an argument cast.
--  "Points are server-side only" was the intent, and the intent never held.
--
--  The same hole was open on every purge, every refresh, the beacon decay
--  and relearn passes, and `reverify_campsites` — a stranger could empty the
--  notification queue or re-run the beacon model on a whim.
--
--  THE FIX, AND THE RULE
--
--  `from public, anon, authenticated` — all three, always. Naming the two
--  roles alone is the bug; PUBLIC is where the privilege actually lives.
--  Migrations 19 and 21 already had it right, which is why `ingest_land_parcels`
--  and `prune_boundary_tile_cache` were the only private functions on this
--  database that were genuinely private.
--
--  WHY REVOKING FROM TRIGGER FUNCTIONS IS SAFE
--
--  PostgreSQL checks EXECUTE on a trigger function when the trigger is
--  CREATED, not each time it fires. Existing triggers keep working; what
--  stops is a stranger calling the trigger body directly over REST.
--
--  WHAT DELIBERATELY KEEPS ITS GRANT
--
--  The twenty-six functions the browser actually calls — the ones behind
--  every RPC in `src/` — are untouched. This migration only closes what was
--  never meant to be open.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
--  1. Points: minting and spending. The reason this migration exists.
-- ---------------------------------------------------------------------
revoke all on function
  public.grant_points(uuid, integer, public.points_reason, text, text, text),
  public.spend_points(uuid, integer, public.points_reason, text, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
--  2. Scheduled maintenance. Called by pg_cron (which runs as the role
--     that scheduled it) and by the API with the service key. No browser
--     has any business calling these.
-- ---------------------------------------------------------------------
revoke all on function
  public.purge_expired_alerts(),
  public.purge_expired_presence(),
  public.purge_notification_queue(),
  public.release_stale_reviews(),
  public.reverify_campsites(),
  public.refresh_zone_alerts(interval, integer),
  public.queue_weather_alerts(),
  public.queue_zone_alerts(),
  public.recompute_trust(uuid),
  public.check_reveal_quota(uuid),
  public.data_quality_report(),
  public.rls_auto_enable()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
--  3. Beacon internals. `beacon_persist_spots` writes the scan results;
--     the rest are the learning passes and the nightly decay.
-- ---------------------------------------------------------------------
--     `beacon_scan_is_fresh` is read-only and asked with the anon key by
--     `beaconRoutes`; `claim_beacon_token` and `refund_beacon_token` act
--     on `auth.uid()` and are called with the SIGNED-IN CAMPER'S token
--     (`getCallerClient`), which is the entire point of them — a token
--     claim has to know whose token it is. All three keep their grants,
--     for the same reason as the boundary reads above.
revoke all on function
  public.beacon_persist_spots(jsonb, double precision, double precision, integer, jsonb),
  public.beacon_refresh_spot_stats(uuid),
  public.beacon_decay(),
  public.beacon_relearn(),
  public.beacon_maintenance()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
--  4. Boundary reads.
--
--     ONLY THE LEGACY OVERLOAD AND THE UNUSED CAMPSITE SEARCH.
--
--     `boundaries_in_bbox` looks server-side — it is called from
--     `server/`, never from `src/` — and the first draft of this migration
--     revoked it on that basis, which would have taken the stored
--     boundaries and the whole offline land pack off the map.
--
--     The lesson, worth more than the fix: "called from `server/`" does
--     not mean "called with the service key". `boundaryRoutes`
--     (`getSeededClient`) and `landPackRoutes` both build their client on
--     VITE_SUPABASE_ANON_KEY and read these as `anon`, because what they
--     are reading — `public_lands` — is world-readable by RLS anyway and
--     the anon key is the right key for a public read. Revoking from
--     `anon` therefore breaks the server, not the browser.
--
--     So the check that matters is which KEY each call site uses, not
--     which directory it lives in. These stay open; they read nothing a
--     camper could not already select from `public_lands` directly.
-- ---------------------------------------------------------------------
revoke all on function
  public.boundaries_in_bbox(double precision, double precision, double precision,
                            double precision, integer),
  public.campsites_near(double precision, double precision, double precision,
                        public.land_type[], integer)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
--  5. Trigger bodies. They fire from their triggers either way; this only
--     stops them being invoked directly over REST.
-- ---------------------------------------------------------------------
revoke all on function
  public.accept_telemetry_batch(),
  public.auto_hide_reported_content(),
  public.bump_photo_votes(),
  public.poi_lifecycle(),
  public.protect_trust_columns(),
  public.queue_booking_notification(),
  public.refresh_campsite_capacity(),
  public.refresh_campsite_rating(),
  public.reward_hazard_confirmation(),
  public.touch_settings(),
  public.touch_updated_at()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
--  6. The API still needs the ones it calls with the service key.
--
--     `service_role` already held an explicit grant on these, and a
--     revoke from PUBLIC does not disturb it — but saying so here means
--     the next person reading this file can see what the server relies on
--     without going to look at `proacl`.
-- ---------------------------------------------------------------------
grant execute on function
  public.beacon_persist_spots(jsonb, double precision, double precision, integer, jsonb),
  public.beacon_scan_is_fresh(double precision, double precision, integer),
  public.claim_beacon_token(),
  public.refund_beacon_token(),
  public.land_sources_covering(double precision, double precision, double precision, double precision),
  public.boundaries_in_bbox(double precision, double precision, double precision,
                            double precision, double precision, integer, double precision),
  public.boundaries_in_bbox_sources(double precision, double precision, double precision,
                                    double precision, double precision, integer,
                                    double precision, text[]),
  public.purge_expired_alerts(),
  public.queue_weather_alerts()
  to service_role;

-- ---------------------------------------------------------------------
--  7. The balances view.
--
--     `points_balances` is a materialized view of every account's points
--     total, and PostgREST will serve a materialized view to whoever can
--     select it. One person's balance is their own business.
-- ---------------------------------------------------------------------
revoke all on public.points_balances from public, anon, authenticated;

commit;

-- =====================================================================
--  AFTERWARDS
--
--  This should return no rows. Each one it does return is a private
--  function a stranger can still call:
--
--    select p.proname, p.proacl::text
--    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and has_function_privilege('anon', p.oid, 'EXECUTE')
--      and p.proname in ('grant_points', 'spend_points', 'beacon_decay',
--                        'purge_notification_queue', 'reverify_campsites');
-- =====================================================================
