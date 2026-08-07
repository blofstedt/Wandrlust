# Full repo — paste over your existing folder

This is your complete source tree with two things folded in:

1. **The alert-overlay feature** (map pin badges, parcel patterns, dissolved
   borders) — `src/utils/alertOverlay.ts` (new) + `src/components/MapComponent.tsx`.
2. **The crash fix** — the missing block restored to `src/services/dataService.ts`,
   and the two leftover import sites repaired (`src/App.tsx`,
   `src/components/CampsiteDetailModal.tsx`).

## How to use

Paste the contents over your repo root, replacing files when asked. `git status`
will then show exactly what changed.

## What is NOT in here (and why that's fine)

Binary files were never part of the text pack this was rebuilt from, so the zip
does **not** contain:

- `public/icons/*.png` (the raster app/notification icons)
- `node_modules/`, `.env`, `package-lock.json`, `dist/`

You are pasting *over* your existing repo, so all of those stay exactly as they
are on disk. Nothing binary is overwritten or deleted. (`public/icons/icon.svg`,
the vector master, IS included.)

## Before pushing

    npm run lint
    npm run dev
