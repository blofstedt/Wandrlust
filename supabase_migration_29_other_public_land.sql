-- ---------------------------------------------------------------------
--  29. A LAND TYPE FOR PUBLIC LAND THAT IS NOT ONE OF THE OTHER FOUR
--
--  `land_type` was ('blm', 'usfs', 'state_forest', 'dispersed',
--  'crown_land'), which covers the land this app started with: two US
--  federal agencies, state forests, Canadian Crown land, and the
--  camper-reported spots that are not really a land class at all.
--
--  Ingesting free, officially-run campgrounds across the rest of the
--  continent immediately produced land nobody has a box for. A county
--  park. A city campground. An Army Corps of Engineers reservoir. A
--  National Park Service site. A state WILDLIFE AREA, which is not a
--  state forest. Each of those is public land run by a named government
--  body, and none of them is any of the five.
--
--  The wrong fix is to round them to the nearest existing value, and it
--  is wrong in the way this schema keeps having to refuse: filing a city
--  park under 'usfs' is the app stating who owns a piece of ground, on
--  the strength of nothing, to a camper deciding whether they are allowed
--  to sleep there. `land_manager` already carries the specific operator
--  name; this value is the honest category above it — public land, run by
--  an agency, not one of the four we name separately.
--
--  Adding a value to an enum is additive and safe: nothing reads
--  land_type exhaustively in SQL, and `campsites_visible` selects the
--  column rather than switching on it.
-- ---------------------------------------------------------------------

alter type public.land_type add value if not exists 'other_public';

comment on type public.land_type is
  'Who manages the ground a campsite sits on. other_public means a named government body that is not one of the four called out separately — see land_manager for which one.';
