# What changed

Plain English. Grouped by why it mattered.

## Bugs fixed

| What was broken | What happens now |
| --- | --- |
| **Push notifications never worked.** `pushRoutes.ts` loaded the `web-push` library with `require()`, which doesn't exist in this project's module system. The error was swallowed, so push silently did nothing even with the library installed and keys set. | Loads properly. If the library genuinely isn't installed you get a one-line warning in the console instead of silence. |
| **The distance slider couldn't reach its own default.** Default radius was 500 miles; the slider only went to 150. The filter badge showed "1 active filter" that you could never clear. | One set of defaults in `src/config/filters.ts`. Slider runs 5–500 miles. Badge is always clearable. |
| **The "Full info" screen was unreachable.** Every button routed to the bottom sheet, so the detail view — and the only way to leave a review — was dead code. | Map pins open the quick sheet. "Full info" on a card opens the full detail view with reviews. |
| **Settings checkboxes reset themselves.** The toggle component was being redefined on every render, so React threw away and rebuilt each checkbox whenever any setting changed. | Toggles keep focus and animate once. |
| **Submitting a campsite with a bad coordinate created an invisible pin.** A typo produced `NaN` latitude and the site vanished from the map with no error. | Coordinates are validated with a clear message. New submissions also start at 0 stars instead of a phantom 5.0, which was pushing them to the top of "highest rated". |
| **Map stuttered when selecting a pin.** Selecting a campsite tore down and rebuilt every marker on the map. | Only the two icons that changed are redrawn. |
| **Offline maps leaked memory.** Every cached tile created a blob URL that was never released — a long pan filled memory. | Released as soon as the tile is drawn. |
| **Out-of-coverage searches said nothing.** Searching outside the US/Canada silently returned no results. | A clear note explains that the area isn't covered yet. |
| **API typos returned the app's HTML.** A wrong `/api/...` URL fell through to the page instead of a real error. | Returns a proper JSON 404. |
| **`npm run vapid` could crash on older Node.** Used a global that isn't guaranteed to exist. | Uses the standard Node crypto call. |
| A dropped timer in the weather proxy, an orphaned push subscription on a failed lookup, and an unbounded weather cache. | All fixed. |

## Removed (dead or harmful)

- **The AI campsite finder.** An endpoint asked a language model to invent
  campsites, coordinates included. Hallucinated coordinates send someone down a
  forest road to a site that isn't there — the exact failure this app is built
  to prevent. Gone, along with the `@google/genai` dependency. Campsites now
  come only from the curated dataset, OpenStreetMap, and other campers.
- **Unused dependencies:** `@turf/turf`, `motion`, `pbf`, `@mapbox/vector-tile`,
  `autoprefixer`, and a duplicate `vite` entry. Nothing imported them. This is
  the single biggest download-size win in the release.
- **Duplicate legal documents** in `src/legal/` — identical to the live copies in
  `public/legal/` and imported by nothing.
- Dead constants and refs: an unused list of "popular locations" in the nav, a
  duplicate map layer, an unused `isCrownLand` field, marker references that
  were written but never read.

## Made faster or tidier

- **Filtering and sorting run in one pass.** Distance was being recalculated for
  every campsite twice per keystroke; now it's computed once.
- **Push dispatch went from ~200 database round trips per batch to 1.**
- **Hazard classification lives in one file** (`shared/hazards.ts`) instead of
  being copy-pasted between the server and the client. Two copies of a
  fire-detection regex is how they drift apart.
- **Bundle splitting actually works now.** The icon library was being swept into
  the React chunk by a rule that matched too broadly.
- **Filter defaults, road-access rankings and land types** live in
  `src/config/filters.ts` instead of being repeated in four places.
- **Distance maths** moved to `src/utils/geo.ts`.
- The nav's tool buttons are generated from a list rather than nine near-identical
  copies of the same markup.

## New

- **`CLAUDE.md`** — the map of the repo for whichever AI picks it up next, with
  instructions to read only what a task needs, plus how you like to work.
- **Road roughness filter.** The app already filtered on it internally but never
  offered the control. It's now in the filter drawer.
- Escape closes the filter drawer and the submit form; clicking the dimmed
  background closes them too.
- Accessible labels on the search, filters and map controls.

## Not touched on purpose

- Every SQL migration, the seeding scripts, the legal text, and the motion
  system. They were in good shape and changing them carries risk with no payoff.
- The unused helpers in `dataService.ts` (bookings, POI voting, rig profiles).
  They're the matching half of tables that already exist in your database and
  are the obvious next features to wire up. Deleting them would cost you later.

## Still worth doing

- No automated tests exist. That's the main thing standing between this and
  confident changes.
- `PRODUCTION.md` still holds an honest list of what isn't launch-ready —
  boundary accuracy, Canadian coverage, the legal review. Nothing here changed
  that list.
