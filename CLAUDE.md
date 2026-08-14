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
| Cell signal by carrier | `src/services/cellCoverageService.ts`, `server/cellRoutes.ts` | everything else |
| Camper hazard reports on the map | `src/config/hazardReports.ts`, `src/components/HazardReportCard.tsx`, `ReportPanel.tsx` | weather |
| Search, filters, view switching | `src/App.tsx`, `src/components/Navbar.tsx`, `src/components/FilterDrawer.tsx`, `src/config/filters.ts` | services |
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
| Camper presence, reporting | `src/components/PresencePanel.tsx`, `ReportPanel.tsx`, `ScoutModePanel.tsx` + `dataService.ts` | map |
| Database schema, tables, policies | `supabase_schema.sql` then `supabase_migration_02…09` **in order** | all of `src/` |
| Loading boundary data | `scripts/seedSupabase.ts`, `scripts/landSources.ts`, `scripts/arcgisTiledFetch.ts` | all of `src/` |
| Legal text | `public/legal/*.md` (the live copies) | code |

**Full file tree**

```
server.ts                  Express API + Vite middleware, one process
shared/hazards.ts          Alert classification shared by client and server
server/
  boundaryRoutes.ts        /api/boundaries — 3 government ArcGIS services, cached
  weatherRoutes.ts         /api/weather + /api/weather/alerts (NWS + Env. Canada)
  openMeteo.ts             Hourly forecast for Canada and NWS gaps
  routeRoutes.ts           /api/route — ORS, then Valhalla, then OSRM
  cellRoutes.ts            /api/cell-coverage — tower-distance estimate
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
  legal/*.md               Privacy, terms, safety disclaimer (live copies)
  map/                     Prebuilt map data, COMMITTED. Regenerate with
                           `npm run map:assets`, never fetched at runtime.
    admin1-us-ca.json      State / province outlines
    land-mask.bin          Land-vs-water bitmask for the pin check
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
- **Canadian boundary data is Ontario and Alberta only.** `coverage_gaps` records
  the rest. Absence of a polygon means "no data", never "no public land".
- **iOS push needs the app installed to the Home Screen.** `pushService.ts`
  detects this and explains it instead of showing a button that fails.
- **Migrations must run in order,** `supabase_schema.sql` then 02 through 17.
  `supabase_schema.sql` is destructive — it drops and recreates.
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
- **There are no automated tests.** Verify changes by reasoning through them and
  by running `npm run lint`. Be careful.

## Deliberately not here

- **No AI-generated campsites.** An endpoint used to invent camping spots with a
  language model. Hallucinated coordinates send someone down a road that doesn't
  exist. It was removed. Don't reintroduce it.
- **No smooth easing.** The motion is Pebble's frame-based "moook" curve on
  purpose — mechanical, with an overshoot that settles. That's the personality.
- **No purchase prompts outside Settings.** The support link buys nothing in the
  app. Points are earned, never sold.