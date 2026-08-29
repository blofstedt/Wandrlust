-- ---------------------------------------------------------------------------
-- 31. Alberta's camping pass is a SHAPE, not a property of every parcel.
-- ---------------------------------------------------------------------------
--
-- Every Alberta parcel in `public_lands` carried
--   permit_required = true
--   permit_name     = 'Alberta Public Lands Camping Pass (Eastern Slopes)'
-- because `scripts/landSources.ts` wrote that flat, for the whole source.
--
-- The Green Area is Crown land from the Montana border to the Northwest
-- Territories. The Public Lands Camping Pass covers a 66,710 km² strip down
-- the Eastern Slopes — about a twelfth of it. So tapping Crown land near Lac
-- La Biche, or Fort Vermilion, or the Peace country produced "Alberta Public
-- Lands Camping Pass (Eastern Slopes) is required here", six hundred
-- kilometres from any ground the pass mentions. The app invented a fee, which
-- is the same failure as inventing a permission and no more forgivable for
-- costing the camper money rather than a fine.
--
-- A PARCEL CANNOT ANSWER THIS. Parcels straddle the pass boundary, and a flag
-- on one is a claim about the whole of it. So the claim is removed from the
-- data entirely and the question is answered where it can be answered
-- honestly — at the camper's own coordinates, against the province's own
-- published outline, which the app holds in `src/config/albertaCampingPass.ts`
-- and reads in `permitForLandPoint` (`src/config/permits.ts`).
--
-- Ontario's row is left exactly as it is: its permit_name is a note about who
-- needs one, `permit_required` is already false, and the regime really does
-- apply to that whole layer.
--
-- Safe to re-run.

update public.public_lands
   set permit_required = false,
       permit_name     = null
 where source_id in ('alberta_green_area', 'alberta_pluz')
   and (permit_required is true or permit_name is not null);
