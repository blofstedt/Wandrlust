-- ---------------------------------------------------------------------
--  33. WITHDRAWING `osm_free`. IT PUT PINS ON PRIVATE LAND.
--
--  Migration 32 added a weaker campsite tier one day ago: OpenStreetMap says
--  a campsite here is free, nobody has recorded who runs it, drawn as a
--  dashed ring instead of the government pentagon, with a chip saying in
--  words that the owner was unknown. It was meant to answer the map being
--  empty east of British Columbia.
--
--  It was checked on the map, and almost every one of the 54 pins was on
--  somebody's private property. They are deleted here and nothing writes
--  this source any more.
--
--  WHY IT FAILED, so it is not tried again the same way.
--
--  `fee=no` means a mapper answered the FEE question. It says nothing
--  whatever about who owns the ground, and OpenStreetMap is full of free
--  campsites that are a farm field, a driveway, or a spot somebody wild
--  camped once and mapped. The operator tag was quietly doing the work
--  nobody credited it with: it was not a formality about attribution, it was
--  the only thing in the record standing between "free" and "yours to use".
--  Removing it did not lower the confidence of the claim, it removed the
--  claim's only evidence.
--
--  AND THE HEDGE DID NOT RESCUE IT. The pin was dashed, dimmed, and carried a
--  chip that said "it could be a government campground, a community field or
--  private land". None of that mattered, because A PIN IS AN INVITATION and
--  qualifying the caption does not make it less of one. A camper scanning a
--  map reads pins, not captions. That is the general lesson and it applies
--  beyond this table: a claim that cannot be made plainly should not be
--  pinned at all, however carefully the words around it are chosen.
--
--  The enum value stays because Postgres cannot drop one cleanly and nothing
--  writes it. The gate in `server/freeCampgroundRoutes.ts` is back to
--  requiring a named government operator, and the east stays thin — which is
--  the correct answer. What answers "where can I camp free" out there is the
--  Crown land boundaries, which come from government sources and actually
--  know who owns the ground.
--
--  Safe to re-run.
-- ---------------------------------------------------------------------

delete from public.campsites where source = 'osm_free';

comment on type public.campsite_source is
  'Where a campsite record came from. `agency_dataset` is a government '
  'publication — authoritative for location and name, and NOT evidence that '
  'anybody has visited. `overpass` is a live per-viewport sweep with the fee '
  'unknown and is never pinned. `osm_free` is WITHDRAWN and must not be '
  'written: it meant OpenStreetMap said free with no operator recorded, and '
  'pinning it put campers on private land — see migration 33.';
