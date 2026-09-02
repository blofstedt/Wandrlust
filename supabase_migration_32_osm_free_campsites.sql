-- ---------------------------------------------------------------------
--  32. FREE IN OPENSTREETMAP, AND NOBODY SAYS WHO RUNS IT
--
--  The pin rule required a government operator, and that rule is why the
--  map showed almost nothing east of British Columbia. Measured, per
--  province, from the ingest's own dry run:
--
--    Alberta   382 campsites tagged fee=no, 359 naming NO OPERATOR AT ALL
--    Ontario    90 in one tile alone, 3 attributed, none of them in Ontario
--    Québec      4 across four tiles, none attributed
--
--  So the gate was not filtering out noise. It was filtering out almost
--  every free campground in the country, on the grounds that OpenStreetMap
--  records what a place IS without recording who owns it.
--
--  WHY THE GATE EXISTED, AND WHY IT STAYS FOR THE PENTAGON. A pentagon pin
--  says a government publishes this campground. Putting one over somebody's
--  field because a mapper typed fee=no would be the app inventing an
--  authority, and that is the failure this codebase exists not to commit.
--  That rule is not being relaxed: `agency_dataset` still requires a named
--  government operator and still gets the pentagon.
--
--  WHAT `osm_free` MEANS, precisely: OpenStreetMap records a campsite here
--  and records that it costs nothing, and NOBODY HAS RECORDED WHO RUNS IT.
--  That is a weaker claim than `agency_dataset` in exactly one way — the
--  authority — and it is drawn weaker: a dashed ring, never a pentagon, with
--  the missing half said out loud on the pin rather than left to be inferred
--  from a silhouette. It is the same idea as the dotted backroad line, which
--  means "nobody wrote the surface down" and must never be read as either of
--  the other two answers.
--
--  It is NOT `overpass`. That value means a site swept live from OSM for one
--  viewport, fee unknown, and pinning those would put a pin on every private
--  campground in the country. `osm_free` is stored, is free-tagged, and has
--  passed the same disqualifiers as an attributed site: named, not
--  backcountry, no permit, no reservation, no stated charge.
--
--  Safe to re-run.
-- ---------------------------------------------------------------------

alter type public.campsite_source add value if not exists 'osm_free';

comment on type public.campsite_source is
  'Where a campsite record came from. `agency_dataset` is a government '
  'publication — authoritative for location and name, and NOT evidence that '
  'anybody has visited. `osm_free` is OpenStreetMap recording a free campsite '
  'whose operator nobody has recorded: the location and the fee come from OSM, '
  'the authority is unknown, and it must be drawn as the weaker claim it is. '
  '`overpass` is a live per-viewport sweep with the fee unknown and is never '
  'pinned.';
