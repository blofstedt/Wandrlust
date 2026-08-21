import { test, expect } from '@playwright/test';
import {
  loadApp,
  enableBoundaries,
  canvasCoverage,
  collectErrors,
  assertNoAppErrors,
  painted,
  sleep,
} from './helpers';

// THE OVERVIEW TIER. Zoomed out (z<5) the map draws the bundled continental
// overview instead of nothing — the answer to "where is there public land
// near here?" must survive a zoomed-out glance. This regressed historically
// when the overview weld was refetched per-viewport; it is now bundled and
// drawn once. Uses the default Canada start view; zooms out until the
// overview pane paints.
test('Canada overview paints from the bundled data at low zoom', async ({ page }) => {
  const { consoleErrors, pageErrors } = await collectErrors(page);

  await loadApp(page);
  await enableBoundaries(page);

  const box = await page.locator('.leaflet-container').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

  // Zoom out until the bundled overview is on screen (or give up).
  let cov: Record<string, { paintedPx: number }> = {};
  for (let i = 0; i < 5 && painted(cov, 'leaflet-coverage-pane') < 2000; i++) {
    await page.mouse.wheel(0, 600);
    await sleep(1800);
    cov = await canvasCoverage(page);
  }

  expect(painted(cov, 'leaflet-coverage-pane'), 'overview should paint on the coverage pane').toBeGreaterThan(2000);

  assertNoAppErrors(consoleErrors, pageErrors);
});
