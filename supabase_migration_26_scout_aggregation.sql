-- =====================================================================
--  Wandrlust - Migration: Scout Paths Aggregation
-- 
--  Adds the missing link between telemetry_batches and road_segments.
-- =====================================================================

begin;

-- Add new token reasons for differentiated scout points
insert into public.token_rules (reason, amount, daily_cap, description) values
  ('scout_existing_road', 5, 12, 'Road-surface telemetry on already-mapped road')
on conflict (reason) do nothing;

update public.token_rules 
set reason = 'scout_new_road', amount = 25, daily_cap = 6, description = 'Road-surface telemetry on unmapped road'
where reason = 'telemetry_batch';

-- Helper function: classify surface from variance
create or replace function public.classify_surface_from_variance(p_variance double precision)
returns public.surface_quality language sql stable security definer
as $$
  select case
    when p_variance < 0.35 then 'smooth_paved'::public.surface_quality
    when p_variance < 1.2 then 'rough_paved'::public.surface_quality
    when p_variance < 3.0 then 'good_gravel'::public.surface_quality
    when p_variance < 7.0 then 'washboard'::public.surface_quality
    when p_variance < 15.0 then 'rutted_dirt'::public.surface_quality
    when p_variance < 30.0 then 'rock_crawl'::public.surface_quality
    else 'impassable'::public.surface_quality
  end;
$$;

commit;