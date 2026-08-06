# Wandrlust

Find free dispersed camping on public land — BLM, US National Forest, and
Canadian Crown Land — with an interactive map, live conditions, fire/flood/
storm alerts, and offline map support for areas with no cell service.

---

## Quick start

```bash
npm install
cp .env.example .env      # optional: all keys are optional
npm run dev
```

Open <http://localhost:3000>. The app runs with **no API keys at all**.

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server behind the Express API, port 3000 |
| `npm run build` | Builds the client to `dist/` and bundles the server |
| `npm start` | Runs the production build |
| `npm run lint` | Typecheck only (`tsc --noEmit`) |
| `npm run seed` | Seed Supabase: campsites, boundaries, then reverify |
| `npm run seed:lands` | Boundary polygons only |
| `npm run vapid` | Generate Web Push VAPID keys |

---

## Data accuracy — read this first

Two things this app **cannot** give you, no matter how the map looks:

**1. Survey-grade property edges.** Not available from any free national
dataset. BLM's own Surface Management Agency metadata states the data "do not
illustrate land status ownership pattern boundaries." Legal boundaries live in
county recorder offices and land title registries.

Every polygon is tagged `edge_accuracy`, and edges are drawn as a **fade, not
a line**. Near a boundary, assume you may be on private land. Private
inholdings inside federal land are not depicted at all.

**2. A guarantee that camping is legal.** No GIS layer encodes this. It depends
on Motor Vehicle Use Maps, travel management plans, seasonal closures and fire
restrictions — nearly all published as PDFs, not queryable geometry. The best
available proxy is PAD-US `Pub_Access = 'OA'` plus excluding designations where
dispersed camping is prohibited. That is a filter, not a guarantee.

### Coverage is not uniform

`coverage_gaps` records regions where we have **no data**, so the app can tell
"no public land here" apart from "we don't know":

| Region | Why |
| --- | --- |
| British Columbia | No open layer of campable Crown land; TANTALIS publishes tenures (encumbrances), the opposite |
| Manitoba, Quebec | No confirmed open REST layer |
| Atlantic Canada | Periodic file downloads, not queryable services |
| Yukon, NWT, Nunavut | Split jurisdiction with major land claim settlement areas — deliberately not modelled |
| US state lands | Rules vary by state; absent from the federal SMA layer |

Canadian coverage is therefore **Ontario and Alberta** — not the whole country.

### Extraction completeness

ArcGIS services cap responses (typically 1,000–2,000 features). A naive query
over the continental US returns 2,000 polygons and silently drops the rest — in
testing against a simulated 180,000-feature service that recovered **1.1%** of
the data with no error raised.

The seeder uses recursive quadtree tiling: any tile returning the record cap is
split into four and re-queried until every tile returns fewer. Same test:
**100%** recovery. Each run writes an `extraction_runs` row with
`completeness_verified`.

---

## Motion & polish

The interface uses a motion system modelled on **PebbleOS**. Pebble's signature
easing is *moook* — not a smooth bezier, but a **frame-based** curve: a short
ramp, linear travel, then an overshoot that settles in discrete steps. That
discreteness is the character.

Measured on our implementation: **17.5% overshoot peaking at t=0.55**, landing
exactly on 1.0.

- `src/utils/animation.ts` — the frame-based curve, for JS-driven work
- `src/index.css` — CSS bezier approximations, keyframes, utilities
- Durations follow Pebble's 250 ms default

**Reduced motion is fully respected.** Under `prefers-reduced-motion: reduce`,
all travel, scale and overshoot are removed — enforced in CSS *and* inside the
JS helpers, so a component can't opt out by accident.

---

## Weather & hazard alerts

Two free government sources, no API keys:

- **US** — NWS `api.weather.gov`. Forecasts plus active alerts.
- **Canada** — ECCC `api.weather.gc.ca`. Alerts only; the open OGC endpoint
  doesn't serve point forecasts, and the app says so rather than inventing one.

Alerts classify into fire / flood / storm / winter / heat / wind. **Fire is
matched first, deliberately** — "Fire Weather Watch" would otherwise fall
through, and getting fire wrong is the most dangerous failure here.

**Fire bans are kept separate from weather alerts.** A Red Flag Warning is a
forecast; a Stage 2 restriction is a legal prohibition from the land manager.
No weather API carries the second one, so `fire_bans` is its own table.

---

## Push notifications

Web Push via service worker, VAPID, and a queue-driven dispatcher.

```bash
npm install web-push
npm run vapid          # paste output into .env
```

Then schedule the matcher (pg_cron) and dispatcher — see
[INTEGRATION.md](./INTEGRATION.md).

**Life-safety alerts ignore quiet hours.** A tornado warning at 3am is exactly
the notification you want at 3am. Booking updates are not.

---

## Authentication

Email (password + magic link) and Google OAuth via Supabase Auth. Setup is a
15-minute walkthrough in **[AUTH_SETUP.md](./AUTH_SETUP.md)**.

Auth is the foundation for everything in migrations 02–08: presence, points,
tiers and push all gate on `auth.uid()`. The app runs fine
unauthenticated — you get the map, search, filters, offline packs and the
curated dataset.

---

## Database

Run the migrations **in order** in the Supabase SQL Editor:

```
supabase_schema.sql                          -- 01 core
supabase_migration_02_platform.sql           -- social, points, trust
supabase_migration_03_provenance.sql         -- accuracy metadata
supabase_migration_04_reviews_and_alerts.sql -- reviews, weather, settings
supabase_migration_05_push_and_legal.sql     -- push, legal acceptance
```

Then `npm run seed`.

Three things worth knowing:

- **`is_crown_land` is gone.** A nullable boolean couldn't distinguish
  "checked, not crown land" from "never checked", and a script wrote `false`
  to every row — which is exactly what made the map render zero markers.
  Replaced by `land_verification` (`unverified`/`verified`/`outside`).
- **`public_lands` only holds campable land.** A `CHECK (camping_allowed is
  true)` constraint makes non-campable parcels impossible to insert, and
  `general_use_basis` is `NOT NULL` so the reasoning is recorded.
- **Writes need the service_role key.** The anon key is public — it ships in
  your bundle. It gets SELECT plus tightly-scoped INSERT, nothing more.

---

## Architecture

```
server.ts                  Express API + Vite middleware (single process)
server/
  boundaryRoutes.ts        /api/boundaries — 3 gov ArcGIS services, cached
  weatherRoutes.ts         /api/weather + /api/weather/alerts
  pushRoutes.ts            /api/push/* — VAPID delivery, queue dispatch

src/
  App.tsx                  state, filtering, view switching
  config/coverage.ts       supported region outline + gating
  services/
    dataService.ts         the client's single door into Supabase
    boundaryService.ts     typed client for /api/boundaries
    weatherService.ts      forecasts + hazard classification
    scoutMode.ts           accelerometer road mapping + false-positive filter
    pushService.ts         Web Push subscription management
    routingService.ts      rig-aware routing (OSRM / ORS)
    offlineStorage.ts      IndexedDB: saved sites, tile cache
  utils/
    animation.ts           PebbleOS moook motion system
    fuzzyBoundary.ts       uncertainty-band rendering
  components/              map, cards, panels, sheets, auth, legal
```

---

## Legal

Three documents in `public/legal/`, written to be read by humans:

| Document | Core message |
| --- | --- |
| `privacy-policy.md` | Name, username, email, password, location stored. Never sold, never shared with third parties. |
| `terms-of-service.md` | We are not liable for your safety on public or private land. |
| `safety-disclaimer.md` | The app is a tool, not a guardian angel. |

`LegalGate` blocks the app until a signed-in user accepts, recorded **per
document version**.

Replace the placeholder contact email and date, and have a lawyer review
before launch.

---

See **[PRODUCTION.md](./PRODUCTION.md)** for the launch checklist and an honest
list of what is *not* yet production ready.

## Licence

Data from OpenStreetMap is © OpenStreetMap contributors, available under the
Open Database Licence.
