import { test, expect } from '@playwright/test';
import {
  loadApp,
  enableBoundaries,
  searchFor,
  canvasCoverage,
  collectErrors,
  assertNoAppErrors,
  painted,
  sleep,
} from './helpers';

// THE FAST-ZOOM FADE RACE — the regression Brian hit as "Not showing."
// (2026-08-21). Five quick zooms in, five quick zooms out (~120ms apart):
// the boundary pane's fade-out used to cancel a newer fade-in mid-flight and
// the land layer stayed invisible (opacity stuck at 0.15). The pane must
// settle at opacity 1 with polygons painted. Re-run after ANY change to
// MapComponent's fade/LOD code.
//
// Runs over Kamloops, BC: the provincial-forest layer is stored (fast,
// deterministic) and covers the viewport — unlike downtown Calgary, where
// zero polygons is the CORRECT answer (municipalities are excluded).
test('boundaries survive a fast zoom-out (fade race)', async ({ page }) => {
  const { consoleErrors, pageErrors } = await collectErrors(page);

  await loadApp(page);
  await enableBoundaries(page);
  await searchFor(page, 'Kamloops');

  // Settle at a detail zoom where the full tier draws (z>=7).
  const box = await page.locator('.leaflet-container').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  for (let i = 0; i < 2; i++) {
    await page.mouse.wheel(0, 600);
    await sleep(150);
  }
  await sleep(7000);
  let cov = await canvasCoverage(page);
  expect(painted(cov, 'leaflet-boundaries-pane'), 'BC forest should paint before the race').toBeGreaterThan(2000);

  // The race: fast in, then fast out — back to the same zoom tier.
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, -600);
    await sleep(120);
  }
  await sleep(250);
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 600);
    await sleep(120);
  }
  await sleep(3500);

  // Pane must be fully opaque (settled), never stuck at a partial fade.
  const opacity = await page.evaluate(() => {
    const pane = document.querySelector('.leaflet-boundaries-pane');
    return pane ? getComputedStyle(pane).opacity : null;
  });
  expect(opacity, `boundary pane opacity stuck at ${opacity}`).toBe('1');

  cov = await canvasCoverage(page);
  expect(painted(cov, 'leaflet-boundaries-pane'), 'polygons gone after the race').toBeGreaterThan(2000);

  assertNoAppErrors(consoleErrors, pageErrors);
});
