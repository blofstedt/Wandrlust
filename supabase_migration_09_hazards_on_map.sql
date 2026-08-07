-- =====================================================================
--  Wandrlust migration 09
--
--  ONE FUNCTION: hazards_near(lat, lon, radius_km).
--
--  WHY IT IS NEEDED
--
--  Camper hazard reports — washouts, flooding, fire activity, enforcement —
--  now draw as icons on the map. Getting them to the browser meant reading
--  their positions, and `hazard_reports.geom` is a PostGIS point. PostgREST
--  serves that column as EWKB hex, so the previous client read
--  (`select * from hazard_reports`) handed the app a string like
--  '0101000020E6100000...' where it expected two numbers. Nothing rendered it
--  before, so nothing broke; the moment a map layer consumes it, it would.
--
--  Every other geometry read in this schema already goes through an RPC that
--  does the projection server-side — nearby_campers, rules_at_point,
--  hazards_at_point. This is the missing one, written the same way, and it
--  filters by distance in the database rather than shipping every active
--  report in the country to a phone.
--
--  WHAT IT DOES NOT DO
--
--  It does not coarsen positions. A hazard report is about a place on a road,
--  not about a person: the whole value of "washout 400 m past the cattle
--  guard" is that it is exactly where it says it is. Presence — which IS about
--  a person — stays grid-snapped through nearby_campers().
--
--  Reporter identity is not returned. A report stands on its confirmations,
--  and who filed it is nobody's business on a map.
--
--  Run AFTER 08.
-- =====================================================================

begin;

create or replace function public.hazards_near(
  in_lat double precision,
  in_lon double precision,
  in_radius_km double precision default 150
)
returns table (
  id         uuid,
  kind       public.hazard_kind,
  latitude   double precision,
  longitude  double precision,
  detail     text,
  confirms   integer,
  disputes   integer,
  created_at timestamptz,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    h.id,
    h.kind,
    st_y(h.geom),
    st_x(h.geom),
    h.detail,
    h.confirms,
    h.disputes,
    h.created_at,
    h.expires_at
  from public.hazard_reports h
  where h.is_active
    and h.expires_at > now()
    and st_dwithin(
          h.geom::geography,
          st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography,
          least(in_radius_km, 400) * 1000
        )
  -- Best-corroborated first, so a truncated result keeps the reports most
  -- campers have stood in front of and agreed with.
  order by (h.confirms - h.disputes) desc, h.created_at desc
  limit 300;
$$;

comment on function public.hazards_near(double precision, double precision, double precision) is
  'Active camper hazard reports near a point, with positions projected to lat/lon. Exact by design — a hazard is a place, not a person.';

-- Readable by anyone, signed in or not. Hazards are safety information and
-- gating them behind an account helps nobody.
grant execute on function public.hazards_near(double precision, double precision, double precision)
  to anon, authenticated;

commit;