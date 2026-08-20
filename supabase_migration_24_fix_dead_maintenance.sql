-- =====================================================================
--  24. Two maintenance functions that have never once run to completion
--
--  Both were found by the simple expedient of calling them. Neither had
--  ever been called: `release_stale_reviews` was a commented-out cron job
--  in migration 04, and `reverify_campsites` is a POST-INSTALL note at the
--  bottom of `supabase_schema.sql`. A function nobody invokes is a function
--  nobody finds out is broken.
--
-- ---------------------------------------------------------------------
--  1. release_stale_reviews() — deleted
--
--     It updates `public.booking_reviews`, which does not exist. Hosting
--     and bookings were taken out of this app (migration 08 is literally
--     named `..._and_no_hosting`) and this function was left behind
--     pointing at one of the dropped tables. It fails immediately:
--
--         relation "public.booking_reviews" does not exist
--
--     The obvious-looking repair is to repoint it at `campsite_reviews`,
--     which does have the right shape — `is_hidden`, `created_at`. That is
--     NOT done here, on purpose. A review is hidden when campers report it
--     (`auto_hide_reported_content`), so a job that un-hides everything
--     older than fourteen days would quietly put reported content back on
--     the map. That is a moderation policy, not a port, and it is not one
--     to adopt by accident while fixing a crash.
--
--     So the dead function goes, and the question of whether hidden
--     reviews should ever be released stays open and visible instead of
--     being answered by a function that could not have answered it.
--
-- ---------------------------------------------------------------------
--  2. reverify_campsites() — repaired, and made honest
--
--     TWO separate faults.
--
--     THE CRASH. It was written as `update ... from lateral (...)` where
--     the lateral subquery selects against the update's own target:
--
--         update public.campsites c set ... from lateral (
--           select p.id from public.public_lands p
--            where st_intersects(p.geom, c.geom) ...) m
--
--     PostgreSQL will not let a FROM-clause lateral reference the row
--     being updated, so every call ends at
--
--         invalid reference to FROM-clause entry for table "c"
--
--     A correlated scalar subquery in the SET does the same job legally.
--
--     THE DANGEROUS PART, which is why this is not a one-line fix. The
--     second statement marked a campsite `outside` — not on public land —
--     whenever no parcel in `public_lands` contained it. That reads
--     absence of data as evidence of private land, and it is the one thing
--     this codebase says it must never do.
--
--     It matters more now than when it was written. `public_lands` fills
--     itself from what campers look at (migration 21), so it is sparse by
--     design and always will be: three parcels of New Brunswick as this
--     migration is written. Run the old function today and all twenty-two
--     campsites would be stamped "outside public land" on the strength of
--     a table that has never been asked about the ground they sit on.
--
--     `land_ingest_coverage` is the fix, because it records exactly which
--     ground the database can speak for. So there are three answers now,
--     and the third is the honest one the function was missing:
--
--       verified    a parcel contains it
--       outside     no parcel contains it AND we hold coverage there, so
--                   the absence is a real answer
--       unverified  no parcel, no coverage — we do not know, and say so
-- =====================================================================

begin;

drop function if exists public.release_stale_reviews();

create or replace function public.reverify_campsites()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare touched integer;
begin
  -- On public land: the parcel that contains it, preferring a source that
  -- designates general use over one that merely names the managing agency.
  update public.campsites c
     set land_verification = 'verified',
         verified_land_id  = (
           select p.id
             from public.public_lands p
            where st_intersects(p.geom, c.geom)
            order by (p.confidence = 'designated_general_use') desc
            limit 1
         ),
         verified_at       = now()
   where exists (
     select 1 from public.public_lands p where st_intersects(p.geom, c.geom)
   );

  get diagnostics touched = row_count;

  -- Off public land — but only where the database actually holds an answer
  -- for that ground. Without the coverage test this line is the map calling
  -- unsurveyed country private.
  update public.campsites c
     set land_verification = 'outside',
         verified_land_id  = null,
         verified_at       = now()
   where not exists (
           select 1 from public.public_lands p where st_intersects(p.geom, c.geom)
         )
     and exists (
           select 1 from public.land_ingest_coverage lc
            where st_intersects(lc.geom, c.geom)
         );

  -- No parcel and no coverage. We have not looked at this ground, and
  -- saying "unverified" is the whole of what we know.
  update public.campsites c
     set land_verification = 'unverified',
         verified_land_id  = null,
         verified_at       = now()
   where not exists (
           select 1 from public.public_lands p where st_intersects(p.geom, c.geom)
         )
     and not exists (
           select 1 from public.land_ingest_coverage lc
            where st_intersects(lc.geom, c.geom)
         );

  return touched;
end;
$$;

-- Same rule as migration 22: PUBLIC is where the implicit grant lives, so
-- PUBLIC is what has to be named. A fresh `create or replace` hands the
-- function a new default ACL, which is exactly how this hole reopens.
revoke all on function public.reverify_campsites() from public, anon, authenticated;

commit;

-- =====================================================================
--  AFTERWARDS
--
--    select land_verification, count(*) from public.campsites group by 1;
--
--  Expect nearly everything `unverified` until `public_lands` has been
--  filled by real use. That is the correct answer, not a disappointing one.
-- =====================================================================
