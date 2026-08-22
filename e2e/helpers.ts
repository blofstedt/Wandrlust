import { test, expect, type Page } from '@playwright/test';

// Shared steps for the map smokes: load, get past the offline-choice screen,
// and switch the Public land layer on. Tile basemaps are NOT asserted
// anywhere — Esri/OSM serve flaky placeholder tiles in this sandbox.
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function loadApp(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(4000);
  const quickMap = page.locator('button', { hasText: 'Quick map' });
  if (await quickMap.count()) {
    await quickMap.first().click({ force: true });
    await sleep(3000);
  }
  await expect(page).toHaveTitle(/Wandrlust/);
}

export async function enableBoundaries(page: Page) {
  const layerBtn = page.locator('button[aria-label="Map layers"]');
  await layerBtn.click({ force: true });
  await sleep(800);
  /*
    `Public land`, not `Public land boundaries` — the layer menu's labels were
    shortened so the whole menu fits a phone without scrolling. `hasText` is a
    substring match, so the old string matched NOTHING and the `if` below
    quietly skipped the toggle: every boundary smoke then ran with the layer
    off and failed on an empty map for a reason the failure never mentioned.
  */
  const toggle = page
    .locator('label', { hasText: 'Public land' })
    .locator('input[type="checkbox"]');
  await expect(toggle).toHaveCount(1);
  if (!(await toggle.isChecked().catch(() => false))) {
    await toggle.check({ force: true });
  }
  await sleep(1200);
  await layerBtn.click({ force: true }); // close; it swallows wheel events
  await sleep(600);
}

export async function searchFor(page: Page, place: string) {
  const input = page
    .locator('input[type="text"], input[placeholder*="search" i], input[placeholder*="Search" i]')
    .first();
  await input.fill(place);
  await sleep(1200);
  await page.keyboard.press('Enter');
  await sleep(2500);
  const sugg = page.locator('[class*="suggest"] li, [class*="result"] li, li').first();
  if (await sugg.isVisible().catch(() => false)) {
    await sugg.click({ force: true });
  }
  await sleep(6000);
}

// Painted (non-background) pixels per leaflet pane — proves polygons drew.
export async function canvasCoverage(page: Page) {
  return page.evaluate(() => {
    const out: Record<string, { paintedPx: number }> = {};
    document.querySelectorAll('.leaflet-pane canvas').forEach((cv) => {
      try {
        const ctx = (cv as HTMLCanvasElement).getContext('2d');
        if (!ctx) return;
        const { width: w, height: h } = cv as HTMLCanvasElement;
        const img = ctx.getImageData(0, 0, w, h).data;
        let painted = 0;
        for (let p = 3; p < img.length; p += 4) if (img[p] > 40) painted++;
        const pane = cv.closest('.leaflet-pane');
        const name = pane ? pane.className.replace('leaflet-pane ', '') : '?';
        out[name] = { paintedPx: painted };
      } catch { /* canvas may be mid-paint */ }
    });
    return out;
  });
}

export async function collectErrors(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  return { consoleErrors, pageErrors };
}

export function assertNoAppErrors(
  consoleErrors: string[],
  pageErrors: string[],
  { ignore = [] as string[] } = {}
) {
  // 504 Gateway Timeouts are the known-flaky upstream class this app is
  // DESIGNED to absorb — Esri/ArcGIS/gov hosts stall and the app keeps
  // last-good data on screen. 404/500s and unhandled page errors still fail
  // loudly. Don't widen this without a reason.
  const real = consoleErrors.filter(
    (e) => !e.includes('504 (Gateway Timeout)') && !ignore.some((i) => e.includes(i))
  );
  expect(real, `console errors: ${real.slice(0, 3).join(' | ')}`).toEqual([]);
  expect(pageErrors, `page errors: ${pageErrors.slice(0, 3).join(' | ')}`).toEqual([]);
}

export const painted = (cov: Record<string, { paintedPx: number }>, pane: string) =>
  cov[pane]?.paintedPx || 0;
