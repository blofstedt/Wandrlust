# CLAUDE.md — read this first

You are the developer on this project. Brian is not.

## Who you're working with

- **Brian is not a developer.** Don't ask him to run debuggers, read stack traces,
  or decide between two implementations. Decide, do it, tell him what changed.
- **He cares about how it looks and feels.** Clean, beautiful UI. Delightful,
  playful UX (PebbleOS-inspired motion — see `src/utils/animation.ts`). If a fix
  makes the interface uglier or clunkier, find another fix.
- **Talk in plain English, concisely.** No jargon dumps. "Fixed the map so pins
  stop disappearing when you zoom out" beats "resolved a stale closure in the
  marker cluster effect."
- **He'll tell you when something's wrong, bluntly.** Take the correction, fix
  it, move on. Don't defend the previous version.
- **Deliver working files, not instructions.** If a change touches five files,
  change five files. Don't hand him a to-do list.

## What this app is

Wandrlust finds free dispersed camping on public land (BLM, US National Forest,
Canadian Crown Land) with an interactive map, live weather and fire/flood/storm
alerts, and offline maps for areas with no cell service.

**The non-negotiable rule of this codebase: never overstate what the data
knows.** Boundaries are approximate, camping legality is inferred, alerts can
fail. Every feature says so out loud. If a change would make the app look more
certain than it is, don't make it.

## How to work in this repo

**Load only what the task needs.** This is a large repo. Read the map below,
open the two or three files that matter, and leave the rest alone. Do not read
the SQL migrations, the seed scripts, or the legal markdown unless the task is
actually about the database, seeding, or legal text.

**Follow the import trail, not the folder.** If you're fixing something in a
panel, start at that component and open only the services it imports.

**Stay in your lane.** A styling fix shouldn't touch the data layer. A database
question shouldn't rewrite components.

## Where things live

| If the task is about… | Open these | Ignore |
| --- | --- | --- |
| The map, pins, boundaries, layers | `src/components/MapComponent.tsx`, `src/services/boundaryService.ts`, `src/utils/fuzzyBoundary.ts`, `src/config/coverage.ts` | everything server-side |
| State/province lines, land-vs-water pin check | `src/services/admin1Service.ts`, `src/services/landService.ts`, `scripts/buildMapAssets.ts` | server routes — there aren't any |
| Picking a destination, navigation mode | `src/components/DestinationSheet.tsx`, `NavigationPanel.tsx`, `TripConditions.tsx`, `src/services/routingService.ts`, `server/routeRoutes.ts` | boundaries |
| The backroads overlay (gravel, dirt, two-track) | `server/backroadRoutes.ts`, `src/services/backroadService.ts`, `src/config/backroads.ts`, the backroads effect in `src/components/MapComponent.tsx` | boundaries, weather |
| Cell signal by carrier | `src/services/cellCoverageService.ts`, `server/cellRoutes.ts` | everything else |
| Camper hazard reports on the map | `src/config/hazardReports.ts`, `src/components/HazardReportCard.tsx`, `ReportPanel.tsx` | weather |
| Search (it answers for the app too), filters, view switching | `src/components/Navbar.tsx`, `src/config/appSearch.ts`, `src/App.tsx`, `src/components/FilterDrawer.tsx`, `src/config/filters.ts` | services |
| Facility layers — toilets, water, propane… | `src/config/facilities.ts`, `src/components/FacilityPicker.tsx`, `src/components/ui/FacilityIcons.tsx`, `server/facilityRoutes.ts` | boundaries |
| A facility's card, its notes, "did you find it?" | `src/components/FacilityCard.tsx`, `FacilityCheckSheet.tsx`, `src/utils/facilityCheck.ts`, `supabase_migration_25_poi_notes.sql` | the map layer |
| The Tools page | `src/components/ToolsView.tsx`, `src/components/MobileTabBar.tsx` | map internals |
| A campsite's detail view | `src/components/CampsiteBottomSheet.tsx` (map pin), `src/components/CampsiteDetailModal.tsx` (list card), `src/components/CampsiteCard.tsx` | map internals |
| Submitting a spot, reporting on one | `src/components/SpotReportSheet.tsx`, `src/config/spotReport.ts`, `src/components/ui/ScalePicker.tsx` | boundaries, weather |
| Beacon spots, the evidence ladder, the knock | `src/config/beacon.ts` (tiers + thresholds), `src/components/BeaconPanel.tsx`, `BeaconVerifyPanel.tsx`, `supabase_migration_14_spot_reports.sql` | campsites |
| Naming a spot, finding nearby facilities | `server/spotContext.ts`, `server/spotRoutes.ts`, `src/services/spotContextService.ts` | all of `src/components/` |
| Weather / fire / flood / storm | `src/services/weatherService.ts`, `src/components/HazardAlertPanel.tsx`, `server/weatherRoutes.ts`, `shared/hazards.ts` | everything else |
| Notifications | `src/services/pushService.ts`, `src/components/PushSettings.tsx`, `server/pushRoutes.ts`, `public/sw.js` | components |
| Sign in / accounts / trust tiers | `src/contexts/AuthContext.tsx`, `src/components/AuthModal.tsx`, `src/components/UserMenu.tsx`, `src/lib/supabase.ts`, `AUTH_SETUP.md` | map, weather |
| Anything reading or writing the database | `src/services/dataService.ts` **first** — it is the only door into Supabase | components |
| Offline maps / saved sites | `src/services/offlineStorage.ts`, `src/components/OfflineManagerModal.tsx` | server |
| Animation, look and feel | `src/utils/animation.ts`, `src/index.css`, `src/components/ui/Sheet.tsx`, `src/components/ui/Feedback.tsx` | services |
| The logo — app icon, favicon, header badge | `shared/brandMark.mjs` (the geometry, drawn once), `src/components/ui/BrandMark.tsx`, `scripts/generateIcons.mjs`, then `npm run icons` | components |
| Camper presence, reporting | `src/components/PresencePanel.tsx`, `ReportPanel.tsx`, `ScoutModePanel.tsx` + `dataService.ts` | map |
| Database schema, tables, policies | `supabase_schema.sql` then `supabase_migration_02…09` **in order** | all of `src/` |
| Loading boundary data | `scripts/seedSupabase.ts`, `scripts/landSources.ts`, `scripts/arcgisTiledFetch.ts` | all of `src/` |
| Legal text | `public/legal/*.md` (the live copies) | code |

**Full file tree**

```
server.ts                  Express API + Vite middleware, one process
shared/hazards.ts          Alert classification shared by client and server
server/
  boundaryRoutes.ts        /api/boundaries — 8 government ArcGIS services, cached
  landGeometry.ts          Merges parcels into one shape, cuts lakes out of them
  weatherRoutes.ts         /api/weather + /api/weather/alerts (NWS + Env. Canada)
  openMeteo.ts             Hourly forecast for Canada and NWS gaps
  routeRoutes.ts           /api/route — ORS, then Valhalla, then OSRM
  cellRoutes.ts            /api/cell-coverage — tower-distance estimate
  backroadRoutes.ts        /api/backroads — unpaved + minor roads from OSM, per viewport
  pushRoutes.ts            /api/push/* — Web Push delivery and queue dispatch
src/
  App.tsx                  State, filtering, which view is showing
  types.ts                 Every shared type. Check here before inventing one.
  config/
    coverage.ts            Supported region + the grey mask outside it
    filters.ts             Default filter values (single source of truth)
  services/                All I/O. Nothing here throws into a render.
  utils/                   animation, geo maths, fuzzy edges, image URLs
  components/              UI. ui/Sheet.tsx and ui/Feedback.tsx are the primitives.
  contexts/AuthContext.tsx Session, profile, points balance
  data/curatedCampsites.ts The bundled dataset the app falls back to
public/
  sw.js                    Service worker — push only, no asset caching
  icons/                   App icons, GENERATED. `npm run icons` after any
                           edit to shared/brandMark.mjs; never hand-edited.
  legal/*.md               Privacy, terms, safety disclaimer (live copies)
  map/                     Prebuilt map data, COMMITTED. Regenerate with
                           `npm run map:assets`, never fetched at runtime.
    admin1-us-ca.json      State / province outlines
    land-mask.bin          Land-vs-water bitmask for the pin check
    lakes-us-ca.json       Big lakes. Bundled into the SERVER (not fetched
                           by the browser) and subtracted from every parcel
                           so the map never paints "campable" over water.
```

## House rules

1. **Services never throw.** Every function in `src/services/` returns an empty
   array, `null`, or `{ ok: false, message }`. The app must keep working with no
   Supabase, no keys, and no internet.
2. **`dataService.ts` is the only file that talks to Supabase tables.**
   Components call it; they never build queries themselves.
3. **Reuse the primitives.** `ui/Sheet.tsx` for any dialog or drawer (it handles
   focus, Escape, scroll lock). `ui/Feedback.tsx` for toasts, skeletons, empty
   states, error boundaries. Don't hand-roll a modal.
4. **Motion comes from the system, not ad hoc CSS.** Use the `anim-*` utility
   classes in `src/index.css` or the helpers in `src/utils/animation.ts`. Every
   animation must still collapse under `prefers-reduced-motion`.
5. **Never put the `service_role` key anywhere in `src/`.** The anon key is
   public by design; security lives in Row Level Security.
6. **Points are server-side only.** Never write to `points_ledger`
   directly — go through the SQL functions.
7. **Add types to `src/types.ts`**, not inline in a component.
8. **Run `npm run lint`** (a TypeScript typecheck) before saying you're done.

## Shipping — do this every time, without being asked

**Work that stays on a branch does not exist.** Vercel builds a branch push as a
private preview with its own URL, behind a login Brian does not use. It is not
the app on his phone. Several changes sat finished-and-invisible this way, and
were reported as "still broken" because from where he was standing they were.

So finishing a change means:

1. Commit on the working branch.
2. **Merge it into `main` and push.** Vercel deploys `main` to production
   automatically — that is the only thing that reaches Brian.
3. **Delete the branch**, local and remote, once merged.
4. Say that it is live, not that it is ready.

Do not wait to be asked to merge, and do not leave a branch open "in case".
If a change is worth committing it is worth shipping.

**Then check it actually works in production.** The deployed API reports itself:

```
/api/boundaries?minLat=..&minLon=..&maxLat=..&maxLon=..&detail=overview&minAreaSqKm=99999999
```

returns `meta.sources[]` with `available` and `featureCount` per source and no
geometry to wade through. `available:false` means that source is failing right
now. Vercel's runtime logs say why — but retention is one hour on this plan, so
look immediately, not tomorrow.

**Test wide as well as narrow.** A source can answer a one-degree box perfectly
and time out on a viewport of the whole Great Lakes. That is exactly how Ontario
and Saskatchewan came to draw as empty provinces while every small-box test
passed. Always check a continent-sized box too.

## Commands

```bash
npm install
npm run dev      # http://localhost:3000 — works with zero API keys
npm run build
npm run lint     # typecheck only
npm run seed     # load boundary data into Supabase (needs service_role key)
npm run map:assets  # rebuild public/map/ from Natural Earth (rarely needed)
npm run vapid    # generate push notification keys
```

## Things that will bite you

- **No router.** `src/main.tsx` branches on `window.location.pathname` for
  `/auth/callback`. Adding routes means adding a router or another branch.
- **Leaflet is imperative.** Map code lives in `useEffect`s that manually add and
  remove layers. Always clean up in the return, or layers stack up invisibly.
- **Boundaries only load at zoom 7+** (`BOUNDARY_MIN_ZOOM` in `config/coverage.ts`).
  "The boundaries disappeared" is usually this.
- **Coverage is CONUS + Canada only.** Outside it, the map greys out and queries
  are skipped. That's deliberate.
- **Canadian boundary data is seven provinces, three of them barely.** Ontario,
  Alberta, New Brunswick and Nova Scotia are properly covered — the last two
  publish the extent of their Crown land itself, so a blank there really is
  private land. British Columbia, Saskatchewan and Manitoba are only their
  provincial forests, a small share of each province's Crown land. Quebec and
  Newfoundland are the two big absences and both have a recorded reason in
  `boundaryRoutes.ts` and `landSources.ts` — read those before researching
  either again. `coverage_gaps` records the rest, and `landDataGap` in
  `src/config/coverage.ts` puts the caveat on screen. Absence of a polygon
  means "no data", never "no public land".
- **The free-campground pins are 95% British Columbia, and that is the source
  data, not a bug.** Asked twice now, so the numbers are written down. 838 of
  the 1,208 shared spots are in BC and 832 of those come from ONE government
  layer — Recreation Sites and Trails BC, the only province or state in the
  coverage area that publishes its free recreation sites as an open,
  no-key layer. Everywhere else falls back to OpenStreetMap via
  `freeCampgroundRoutes.ts`, which requires `fee=no` AND a government
  operator, and the second half is where Canada east of BC falls away:
  Alberta has 382 campsites tagged free and **359 of them name no operator at
  all** (Ontario: 353 and 85). The US tags operators routinely — "US Forest
  Service", "BLM" — so Washington turns 298 free-tagged into 80 official and
  Idaho 108 into 80. Run `?dry=1` on the ingest to see the blank count and the
  unrecognised operator strings per region before theorising again. Widening
  the operator patterns is worth doing when the diagnostic shows a real miss —
  it found five in August 2026 (a province or state naming itself, plural
  "National Forests", NYSDEC, "Parks, Recreation and…") and those were worth
  41 campgrounds — but it will never turn the east into BC. What answers "where
  can I camp free" in Alberta and east is the CROWN LAND BOUNDARIES, not
  campground pins, and the unattributed OSM sites still reach the list through
  `/api/osm-campsites`; they just do not earn a pin.
- **BC is the one source that is not ArcGIS.** DataBC publishes WFS, which
  cannot generalise geometry server-side, so `boundaryRoutes.ts` reads it
  against a byte budget, simplifies locally, and past 2.5° asks only for the
  biggest forests in view (sorted server-side on `FEATURE_AREA_SQM`) and
  reports the answer truncated. Measured in production: a 1° box is nine
  forests, a 2° box is 16MB, a continental box gets the biggest three. So BC
  is deliberately partial when zoomed out and complete when zoomed in — that
  is the design, not a bug. If BC stops drawing, check `meta.sources[]` and
  the logs: every WFS response prints its size, its timing, and the layer's
  real field names.
- **The zoomed-out map asks for the BIGGEST parcels, not the first ones.**
  Every source has a hard record cap at wide zoom, and the area filter then
  drops what is too small to draw — so taking whatever the database offered
  first is how Ontario came to draw as confetti over a province that is mostly
  Crown land. `areaField` per source plus `orderByFields` fixes it, between 2.5°
  and 30° of span. Wider than that the sort is too slow and the ask reverts;
  what saves the continental view is that each source is clipped to its own
  extent first, so "the whole continent" becomes "Ontario" (21°) before anyone
  is asked. Sorted answers get their own tile-cache slot (`|big`) — they are a
  different answer to the same question.
- **A province that fails to weld looks empty, not broken.** Three separate
  steps between the government server and the screen can silently drop land,
  and all three end the same way: the merged shape is missing, the source
  falls back to loose parcels, the area filter cuts those to the three
  biggest, and half a province draws as three shapes. The three are: parcels
  thinned to slivers before the union (the ask offset is capped for this),
  polygon-clipping refusing a whole batch over one malformed ring (welded in
  chunks of 64 now, so one bad parcel costs its neighbourhood and not the
  province), and the snap grid being wider than every parcel (welds unsnapped
  instead). Every merge now prints one line — parcels, rings, trims, time,
  pieces, and why it fell back. **Read it before theorising**; working out
  which of the three it was by elimination cost three deploys.
- **The campsite cache has its own epoch, and it is a SECOND one.**
  `CACHE_EPOCH` in `src/services/offlineStorage.ts` invalidates the stored
  campsite set the same way `BOUNDARY_DATA_EPOCH` invalidates boundaries, and
  it exists because the cache shipped without one and was caught by the
  documented trap within a day: 41 campgrounds were drawing as the neutral
  tent because the ingest never set their `setting`, and fixing that
  server-side changed nothing on a phone already holding a stored answer.
  Bump it when a change alters WHAT A STORED SPOT MEANS. Do NOT bump it for
  merely adding spots — the six-hour refresh covers those, and discarding the
  set for a routine ingest is a download nobody needed.
- **A change to what the map draws needs `BOUNDARY_DATA_EPOCH` bumped**
  (`src/services/boundaryService.ts`). Boundaries are cached twelve hours in
  memory, seven days on disk and six in the browser, so without it a fix is
  invisible on every phone that has already looked at that ground. **Adding a
  source counts.** This rule was written and then broken the same day: New
  Brunswick and Nova Scotia shipped, drew perfectly in production, and were
  invisible to the one person watching, because his phone still had a valid
  answer from an hour before they existed.
- **The app answers on five hostnames and only one of them works.**
  `wandrlust.dev` is the app. The other four — `www`, and three
  `*.vercel.app` aliases — are historical, and every `.vercel.app` one sits
  behind Vercel's SSO login wall (`all_except_custom_domains`), which a camper
  cannot pass. `vercel.json` redirects page loads off them, but that does not
  save an INSTALLED app: the manifest's `start_url` is relative, so a
  home-screen install launches on whichever host it was installed from, and
  the service worker then serves the shell from that origin's cache with no
  navigation for the redirect to catch. `localStorage` is per-origin, so the
  session lives on the wrong site and the app looks completely normal.
  **Beacon is the only feature that breaks**, because it is the only route
  that sends the camper's token to our own server — everything else talks to
  Supabase directly and does not care which origin it is on. That is why this
  presented as "Beacon is broken" for three rounds of fixes.
  `src/utils/canonicalHost.ts` now tears down the worker and moves a stranded
  document to the canonical origin before the app mounts. **The upstream cause
  is Supabase's Site URL** — an un-allowlisted redirect is not refused, it
  silently falls back to Site URL, so pointing that at a `.vercel.app` address
  strands every camper who signs in. Exact values in `AUTH_SETUP.md` §2.3.
  **A 401 from `/api/beacon/query` logs the host it arrived on** — read that
  line before theorising; it is what finally answered this.
- **iOS push needs the app installed to the Home Screen.** `pushService.ts`
  detects this and explains it instead of showing a button that fails.
- **Migrations must run in order,** `supabase_schema.sql` then 02 through 25.
  `supabase_schema.sql` is destructive — it drops and recreates.
- **`public_lands` fills itself now, from production, and that is the only
  thing that ever could have filled it.** `npm run seed` needs a machine that
  can reach eight government services; no such machine has ever run it, and
  the agent sandbox is refused at the gateway for every government host. So
  the API stores what it fetches: a detailed request answers from the live
  services, and those parcels are written to `public_lands` with the exact box
  they cover before the response goes out (before, not after — Vercel may
  freeze the function the moment it responds). The next look at that ground is
  one indexed read. `meta.sources[].servedFrom` says `stored` when a source
  came from the table, against `live`, `db` (the tile cache) and `memory`.
  **Two rules keep it honest and must not be relaxed.** Only complete answers
  are stored — a truncated one is the service saying it withheld parcels, and
  stored as if whole it becomes the map claiming land is private. Only sharp
  ones are stored — `INGEST_MAX_TOLERANCE`, about 100 m — because stored
  geometry is read back at every zoom. And coverage is claimed ONLY when every
  storable parcel actually stored: the first version recorded coverage after
  storing nothing, which is the map promising to answer for ground it does not
  hold. Zero of zero is fine and is how empty country stops being re-asked
  forever. Because only detailed views qualify, the zoomed-out overview still
  goes live — it fills in behind you as you use the map, it does not preload.
- **`revoke ... from anon, authenticated` does nothing on its own.** A new
  function carries an implicit `grant execute to PUBLIC`, and both roles are
  members of PUBLIC, so revoking the privilege they were never separately
  granted leaves the inherited one in place. Six migrations "locked down"
  their private functions this way and none of them did — including
  `grant_points`, which meant anyone holding the anon key that ships in the
  JavaScript bundle could POST to `/rest/v1/rpc/grant_points` and mint any
  account any balance. **Always name all three: `from public, anon,
  authenticated`.** The ACL is the proof, not the migration file — a leading
  `=X/postgres` in `proacl` IS the PUBLIC grant, still sitting there after the
  revoke ran:

  ```sql
  select proname, proacl from pg_proc  -- {=X/…} means PUBLIC can still call it
   where pronamespace = 'public'::regnamespace and proname = 'grant_points';
  ```

  A `create or replace` hands the function a fresh default ACL, so re-creating
  one silently reopens the hole. Re-revoke in the same migration.
- **Which KEY a call uses, not which folder it lives in, decides its role.**
  The obvious rule — "`src/` is the browser, `server/` is the service key" —
  is wrong often enough to break things. `boundaryRoutes` (`getSeededClient`)
  and `landPackRoutes` read boundaries with the ANON key, because
  `public_lands` is world-readable and anon is the honest key for a public
  read; `beaconRoutes` calls the token functions with the SIGNED-IN CAMPER'S
  JWT (`getCallerClient`), because they act on `auth.uid()`. Revoking those
  from `anon` takes down the stored boundaries and the whole offline land
  pack while the browser carries on fine. Grep the call site for which client
  it builds before changing a grant.
- **A function nobody calls is a function nobody knows is broken.** Two were
  found by the simple act of running them: `release_stale_reviews` updated a
  table hosting took with it when it left, and `reverify_campsites` could
  never execute at all (an UPDATE whose lateral subquery referenced its own
  target). Both had sat in POST-INSTALL comments for their whole lives. If a
  migration ends with "now run this", run it, in that session.
- **Absence of a parcel is not evidence of private land — in SQL too.**
  `reverify_campsites` marked a campsite "outside public land" whenever no
  row in `public_lands` contained it. That table fills itself from what
  campers happen to look at and is sparse by design, so the honest third
  answer is `unverified`, and `outside` is claimed only where
  `land_ingest_coverage` says the database actually holds an answer for that
  ground. The map rule applies everywhere, not just to what draws.
- **A merged pull request is not a shipped feature.** Vercel deploys the code
  the moment `main` moves; nothing deploys the SQL. Migration 14 sat unapplied
  for a release and migration 17 for another, and both times the symptom was a
  feature that looked broken rather than absent — an RPC that is not there
  comes back as an error, every service turns an error into its safe empty
  value, and the button, the ladder or the panel simply never appears. **If a
  change adds or edits a `supabase_migration_*.sql`, apply it to the live
  database in the same session and say so.** Check first, do not assume:
  `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'`.
- **A spot is only yours to delete while it is only yours.** The camper who
  added a spot can remove it — from the pin's info sheet, and from the Beacon
  sheet — right up until somebody else reviews it, checks in, saves it or
  reports on it. After that it is on other people's maps and the remove control
  is replaced by a sentence saying so. Migration 17 decides; the client asks
  first only so it never draws a button that would be refused. This is not the
  knock path and must never be folded into it: taking down your own pin records
  no enforcement and never turns anything red.
- **An unanswered question is not a zero.** Every scale in a spot report is
  nullable, and null means nobody answered. Never `coalesce(..., 0)` one of
  them on the way out — a spot nobody has rated must not read as "pitch black,
  no view, sloped".
- **A knock turns a spot red, it does not delete it.** `flagged` stays on the
  map carrying the reporter's words; only `withdrawn` (gated, built on, gone)
  disappears. Deleting a spot somebody got moved on from just means the next
  camper rediscovers the same pullout with no warning attached.
- **The API runs as one Vercel serverless function.** The filesystem is
  read-only apart from `/tmp`, and there is a 30-second cap. "Download a big
  dataset on first request and cache it on disk" silently fails and re-downloads
  on every cold start. Big static datasets get prebuilt into `public/map/` and
  committed instead — see `scripts/buildMapAssets.ts`.
- **A blank backroads layer has five possible meanings** and only one of them
  is "there are no roads here" — and even that one is really "nobody has
  mapped one". Zoomed out past `BACKROAD_MIN_ZOOM`, still loading, Overpass
  unreachable, more roads than the map will draw, and genuinely nothing
  recorded all render as an empty screen, so each one says which it is
  (`backroadNotice` in `MapComponent.tsx`). The four line styles are making
  four different claims too: solid means OSM recorded an unpaved surface,
  dashed means it is a purpose-built track, DOTTED MEANS NOBODY WROTE THE
  SURFACE DOWN, and faint means access is restricted. Never collapse the
  dotted case into either of the others.
- **There are no automated unit tests.** Verify changes by reasoning through
  them and by running `npm run lint`. Be careful. The `e2e/` specs are
  Playwright smokes run by hand with `npm run test:e2e`; most of them hit the
  real services, and `e2e/backroads.spec.ts` deliberately does not — it stubs
  `/api/backroads` because what it is checking is our half.

## Deliberately not here

- **No AI-generated campsites.** An endpoint used to invent camping spots with a
  language model. Hallucinated coordinates send someone down a road that doesn't
  exist. It was removed. Don't reintroduce it.
- **No smooth easing.** The motion is Pebble's frame-based "moook" curve on
  purpose — mechanical, with an overshoot that settles. That's the personality.
- **No purchase prompts outside Settings.** The support link buys nothing in the
  app. Points are earned, never sold.
