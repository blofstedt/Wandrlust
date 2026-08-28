-- ---------------------------------------------------------------------
--  26. CAMPSITES THAT CAME FROM A GOVERNMENT DATASET
--
--  `campsite_source` had four values and none of them fitted a campground
--  read out of an agency's own published data:
--
--    verified          implies a person checked it. Nobody has.
--    overpass          implies OpenStreetMap is the source. It is not — OSM
--                      corroborates the FEE here, the site itself comes from
--                      the province.
--    user_submitted    plainly wrong.
--    gemini_discovered  the removed AI endpoint. Never reuse it.
--
--  Filing these under `verified` would have been the app claiming a human
--  had been there, which is the exact overstatement the tier system in
--  Beacon exists to prevent. So they get their own value.
--
--  WHAT `agency_dataset` MEANS, precisely: the location and name come from
--  a government dataset, and nothing about the campsite has been confirmed
--  on the ground by anybody. It ranks below a verified site and above a
--  lead, and the description on each row says what is and is not known.
-- ---------------------------------------------------------------------

alter type public.campsite_source add value if not exists 'agency_dataset';

comment on type public.campsite_source is
  'Where a campsite record came from. `agency_dataset` means a government '
  'publication (e.g. Recreation Sites and Trails BC) — authoritative for '
  'location and name, and NOT evidence that anybody has visited or that any '
  'amenity or fee shown is currently accurate.';
