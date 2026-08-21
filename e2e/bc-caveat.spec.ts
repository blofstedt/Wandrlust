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

// THE BC CAVEAT CHIP. BC draws its provincial-forest designation (≈97% of the
// province), so the chip must say what that layer does NOT subtract — not the
// old, wrong "most BC Crown land is not mapped". Verified live against the
// deployed app 2026-08-21; this keeps the copy honest forever.
test('BC caveat chip is honest and fits the viewport', async ({ page }) => {
  const { consoleErrors, pageErrors } = await collectErrors(page);

  await loadApp(page);
  await enableBoundaries(page);
  await searchFor(page, 'British Columbia');

  // Chip only shows at detail zoom (z>=7): nudge in a few notches.
  const box = await page.locator('.leaflet-container').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -600);
    await sleep(150);
  }
  await sleep(8000); // full-tier fetch + paint (BC layer is big)

  // Polygons painted.
  const cov = await canvasCoverage(page);
  expect(painted(cov, 'leaflet-boundaries-pane')).toBeGreaterThan(2000);

  // The chip itself: new honest copy, no old claim, no overflow.
  const chip = page.locator('span', { hasText: 'provincial forests' }).first();
  await expect(chip).toBeVisible();
  const text = (await chip.innerText()).replace(/\s+/g, ' ').trim();
  expect(text).toContain('nearly all BC Crown land');
  expect(text).toContain('not subtracted');
  expect(text).not.toContain('most BC Crown land is not');
  const cb = await chip.boundingBox();
  expect(cb).not.toBeNull();
  expect(cb!.x).toBeGreaterThanOrEqual(0);
  expect(cb!.x + cb!.width).toBeLessThanOrEqual(390 + 1);

  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollW).toBeLessThanOrEqual(390 + 1);

  assertNoAppErrors(consoleErrors, pageErrors);
});
