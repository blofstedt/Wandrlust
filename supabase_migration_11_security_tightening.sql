-- =====================================================================
--  Wandrlust migration 11 — security tightening
--
--  Two unrelated findings from Supabase's security advisor. One is fixed
--  here; the other cannot be fixed by us and is documented so nobody
--  spends an afternoon rediscovering why.
--
--  Run AFTER 10.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
--  1. Pin search_path on the six functions that were missing it
-- ---------------------------------------------------------------------
--
--  A function with a mutable search_path resolves its unqualified names
--  using whatever search_path the CALLER happens to have. The attack is
--  ordinary: create a schema early in your own search_path, put a table
--  or operator there shadowing the one the function meant, then call the
--  function and have it act on yours instead.
--
--  None of these six is SECURITY DEFINER, so nothing here escalates to
--  the definer's rights and this is hardening rather than a live hole.
--  But `protect_trust_columns` is the trigger that stops a user editing
--  their own trust tier, and a trigger whose name resolution a caller can
--  influence is not one to leave loose.
--
--  Everything added in migration 10 already pins its search_path; these
--  predate it. `alter function` sets the property without touching the
--  body, so there is no risk of the definition drifting from source.

alter function public.touch_updated_at()                       set search_path = public, pg_temp;
alter function public.touch_settings()                         set search_path = public, pg_temp;
alter function public.protect_trust_columns()                  set search_path = public, pg_temp;
alter function public.coarsen_point(geometry, double precision) set search_path = public, pg_temp;
alter function public.in_quiet_hours(user_settings, text)       set search_path = public, pg_temp;
alter function public.tier_rank(trust_tier)                     set search_path = public, pg_temp;

commit;

-- =====================================================================
--  2. RLS on public.spatial_ref_sys — WE CANNOT DO THIS. READ FIRST.
-- =====================================================================
--
--  This is the advisor's only ERROR-level finding, and it is the one
--  thing in the database we are not permitted to change.
--
--  Running the statements below as `postgres` — which is what the
--  Supabase SQL editor, this migration, and every migration runner
--  connect as — fails with:
--
--      ERROR: 42501: must be owner of table spatial_ref_sys
--
--  That is Postgres refusing, not Supabase being awkward.
--  `spatial_ref_sys` is owned by `supabase_admin` and belongs to the
--  `postgis` extension, and only its owner may enable RLS on it. No
--  grant works around it; ownership is the requirement.
--
--  WHAT THE TABLE IS: PostGIS's EPSG catalogue. ~8,500 rows describing
--  coordinate reference systems. It ships with the extension, it is
--  byte-identical in every PostGIS database on earth, and it contains
--  nothing about anybody. The practical exposure is nil — this is a
--  clean-scan problem, not a data-leak one.
--
--  HOW TO ACTUALLY CLEAR IT, best option first:
--
--    1. Ask Supabase support to run the block below. They connect as
--       `supabase_admin`; it takes seconds. Low risk, do this.
--
--    2. Move PostGIS out of `public` into the `extensions` schema, where
--       Supabase installs it by default now. The advisor then stops
--       flagging it because it is no longer a public table. DO NOT DO
--       THIS CASUALLY HERE: `campsites`, `hazard_reports`, `pois` and
--       `presence` all carry geometry/geography columns whose types
--       resolve through search_path, and moving the extension under them
--       can break those columns and every function that reads them. That
--       is a planned migration with a backup, not a quick fix. (The same
--       advisor flags `pg_trgm` in public for the same reason; it is a
--       far easier move if you want one of them done.)
--
--    3. Leave it and record it as a known exception in the security
--       review. Given what the table holds, that is defensible.
--
--  THE POLICY IS NOT OPTIONAL if step 1 or 2 happens. ENABLING RLS
--  WITHOUT IT WOULD BREAK THE MAP: every PostGIS reprojection —
--  st_transform, and the ::geography casts inside campsites_visible,
--  hazards_near, nearby_campers and rules_at_point — reads this table as
--  the CALLING user. RLS on with no policy means anon and authenticated
--  are denied and every distance query in the app starts failing. Read
--  for everyone, writes for nobody, is exactly the access that exists
--  today; the policy only states it out loud.
--
--  ---- for whoever can run it, as supabase_admin -------------------
--
--  alter table public.spatial_ref_sys enable row level security;
--
--  drop policy if exists "read: coordinate reference systems"
--    on public.spatial_ref_sys;
--
--  create policy "read: coordinate reference systems"
--    on public.spatial_ref_sys for select to anon, authenticated
--    using (true);
--
--  -- No insert/update/delete policy, so those stay denied by default.
--  ------------------------------------------------------------------
--
--  Left commented deliberately: an uncommented statement here would make
--  this migration fail on a permission error nobody can fix from this
--  side, and take the search_path fixes above down with it.