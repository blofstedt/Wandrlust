# Production readiness

Honest status of what's shippable, what needs configuration, and what is
genuinely not done. Read "NOT production ready" before launching.

---

## Ready to ship

**Motion system.** Pebble-inspired throughout. `moook` verified at 17.5%
overshoot peaking at t=0.55, landing exactly on 1.0.

**Reduced motion.** Every animation collapses under
`prefers-reduced-motion: reduce`, enforced globally in CSS *and* in the JS
helpers so a component can't opt out by accident.

**Error isolation.** Scoped `ErrorBoundary` around the map means a Leaflet
crash doesn't take out the list view or saved sites.

**Dialog accessibility.** The `Sheet` primitive handles focus-in on open,
focus-return on close, tab trapping, Escape, scroll lock without the iOS jump,
`role="dialog"` + `aria-modal`, and backdrop-press that only fires when the
press *starts* on the backdrop.

**Toasts.** Live region for screen readers. Errors persist until dismissed.
Stack capped at 4.

**Build.** Vendor chunks split so a code change doesn't invalidate Leaflet in
everyone's cache. `console.log` stripped in production, `warn`/`error` kept.

**Push.** Service worker handles `pushsubscriptionchange` — ignore that event
and users silently stop receiving alerts while everything *looks* fine.

---

## Needs your configuration

| Item | Why |
| --- | --- |
| Supabase project + migrations 01–20 | Everything account-bound. Apply all of them, in order — an unapplied migration reads as a missing feature, not an error |
| Google OAuth credentials | See `AUTH_SETUP.md` |
| `npm run seed` | Boundary data is empty until you run it |
| `npm run vapid` + `web-push` | Push delivery |
| `NWS_USER_AGENT` | NWS asks for a contact string |
| Custom SMTP in Supabase | Built-in sender is rate-limited to near-uselessness |
| `ORS_API_KEY` | Optional. Routing works without it via Valhalla; this adds real rig-dimension routing |
| `OPENCELLID_API_KEY` | Otherwise the cell signal panel says it has no data |

---

## NOT production ready

**1. Boundary data is advisory, and the stakes are trespass.**
No dataset here is survey-grade. Before launch, either license parcel data
(Regrid, ~$80K/yr national) or keep the uncertainty band prominent. onX — the
category benchmark — is only accurate to ~±20 ft with paid county data.

**2. Canadian coverage is seven provinces, most of them partial, not a country.**
Ontario (CLUPA General Use Areas, minus the Far North) and Alberta (the Green
Area) are the well-covered two. British Columbia, Saskatchewan and Manitoba are
drawn only where a provincial forest is designated — Crown land by definition,
and a fraction of what each province actually holds; BC alone is roughly 95%
Crown land. New Brunswick and Nova Scotia publish the extent of their Crown
land itself and are the only two provinces where a blank really means private
land. Quebec, Newfoundland and Labrador, Prince Edward Island and the
territories have no usable open layer — Quebec and Newfoundland for specific,
recorded reasons rather than for want of looking. `coverage_gaps` records all of this and `landDataGap` puts the
caveat on screen — make sure it stays visible before Canadian users assume
absence means "no public land".

**3. No automated tests.**
Verification has been targeted scripts (moook curve, hazard classification,
mount detection, coverage polygon, tiling completeness). Those proved the
algorithms; they are not a regression suite. Add Vitest before a second
developer joins.

**4. Rate limiting is partly in-memory.**
`scrape_guard` is in Postgres and survives restarts, but the weather and
boundary proxy caches are per-process `Map`s. Behind more than one instance
they'll diverge. Move to Redis before horizontal scaling.

**5. Legal pages need a lawyer.**
The documents say what you asked, clearly. Whether a liability waiver holds up
depends on jurisdiction — consumer protection law limits what disclaimers can
do in many places. Replace the placeholder contact email and date.

**6. Points economy is unaudited at scale.**
Caps are tuned for ~60 points/day realistic. Nobody has tried to break it.
Model what a determined farmer can extract before opening signups.

**7. No error reporting sink.**
`ErrorBoundary` currently `console.error`s. Wire Sentry or equivalent.

**8. DOT 511 has a table but no feeds.**
Each state DOT has its own endpoint and terms — a per-jurisdiction integration.

---

## Pre-launch checklist

```
[ ] Migrations 01–20 applied in order (check pg_proc for the functions each adds)
[ ] npm run seed completed; data_quality_report() looks sane
[ ] Google OAuth: production origin + redirect URL added
[ ] Supabase Site URL off localhost
[ ] Confirm email turned back ON
[ ] Custom SMTP configured
[ ] VAPID keys generated; push tested on a real device
[ ] service_role key absent from client bundle (grep dist/)
[ ] Boundary accuracy disclaimer shown on first run
[ ] Coverage gaps visible on the map
[ ] Legal docs reviewed by a lawyer; placeholders replaced
[ ] Error reporting sink wired
[ ] Lighthouse: performance, a11y, best practices
[ ] Tested with prefers-reduced-motion enabled
[ ] Tested with keyboard only
[ ] Tested with a screen reader
[ ] Tested offline
```

---

## Verifying the motion work

```
macOS:    System Settings → Accessibility → Display → Reduce motion
Windows:  Settings → Accessibility → Visual effects → Animation effects
Chrome:   DevTools → Rendering → Emulate prefers-reduced-motion
```

Everything should still function, just without travel or overshoot.

Keyboard pass: Tab through the app. Focus rings must always be visible, dialogs
must trap focus, Escape must close them, and focus must land back on the
control that opened them.
