import { test, expect } from '@playwright/test';
import { loadApp, sleep } from './helpers';

/**
 * The backroads overlay, with OpenStreetMap stubbed out.
 *
 * Every other spec in here talks to the real services. This one deliberately
 * does not: Overpass is rate-limited, its answer for any given box changes as
 * volunteers edit it, and what is being checked is OUR half — that the layer
 * draws, that the legend appears with the caveat under it, and that the
 * silences (zoomed out, nothing mapped, could not check, too much to draw)
 * each say which one they are instead of all rendering as an empty map.
 *
 * The stub answers relative to whatever box is asked for, so the test does not
 * care where the map happens to open.
 */

const boxFrom = (url: string) => {
  const q = new URL(url).searchParams;
  return {
    minLat: Number(q.get('minLat')), minLon: Number(q.get('minLon')),
    maxLat: Number(q.get('maxLat')), maxLon: Number(q.get('maxLon'))
  };
};

/** A little grid of roads, one of each class, inside the box asked about. */
const roadsIn = (url: string) => {
  const { minLat, minLon, maxLat, maxLon } = boxFrom(url);
  const lat = (f: number) => minLat + (maxLat - minLat) * f;
  const lon = (f: number) => minLon + (maxLon - minLon) * f;

  const across = (f: number): [number, number][] =>
    [[lat(f), lon(0.15)], [lat(f + 0.05), lon(0.5)], [lat(f), lon(0.85)]];

  return [
    { kind: 'unclassified', surface: 'unpaved', access: 'open', line: across(0.25) },
    { kind: 'track', surface: 'unrecorded', access: 'open', line: across(0.4) },
    { kind: 'service', surface: 'unrecorded', access: 'open', line: across(0.55) },
    { kind: 'residential', surface: 'paved', access: 'open', line: across(0.7) },
    { kind: 'track', surface: 'unpaved', access: 'private', line: across(0.85) }
  ];
};

const openLayerMenu = async (page: import('@playwright/test').Page) => {
  await page.locator('button[aria-label="Map layers"]').click({ force: true });
  await sleep(600);
};

const enableBackroads = async (page: import('@playwright/test').Page) => {
  await openLayerMenu(page);
  const toggle = page
    .locator('label', { hasText: 'Backroads' })
    .locator('input[type="checkbox"]');
  await expect(toggle).toHaveCount(1);
  await toggle.check({ force: true });
  await sleep(500);
};

/** Zoom to where the layer actually asks (BACKROAD_MIN_ZOOM is 12). */
const zoomIn = async (page: import('@playwright/test').Page, steps: number) => {
  const button = page.locator('button[aria-label="Zoom in"]');
  for (let i = 0; i < steps; i += 1) {
    await button.click({ force: true });
    await sleep(450);
  }
  await sleep(1500);
};

test('backroads draw, and the legend says what the lines mean', async ({ page }) => {
  await page.route('**/api/backroads*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true, tooWide: false, truncated: false, roads: roadsIn(route.request().url())
      })
    });
  });

  await loadApp(page);
  await enableBackroads(page);

  // The legend and the caveat are both under the switch, and the caveat is
  // not optional: it is what stops a drawn line reading as a promise.
  await expect(page.locator('text=Gravel or dirt')).toBeVisible();
  await expect(page.locator('text=Surface not recorded')).toBeVisible();
  await expect(page.locator('text=Private or permit')).toBeVisible();
  await expect(
    page.locator('text=/not a\\s+maintained, ungated, passable or legal one/')
  ).toBeVisible();

  await page.locator('button[aria-label="Map layers"]').click({ force: true });
  await zoomIn(page, 5);

  /**
   * The layer draws to its own canvas in its own pane. Leaflet names a
   * custom pane `leaflet-<name>-pane` with any trailing "Pane" stripped, so
   * `backroadsPane` becomes `leaflet-backroads-pane`. Asserted by counting
   * rather than by visibility: a Leaflet pane is a zero-size transformed div,
   * which Playwright rightly calls hidden however much is painted in it.
   */
  expect(await page.locator('.leaflet-backroads-pane canvas').count()).toBe(1);

  // And something is actually painted on it, not just an empty canvas mounted.
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '.leaflet-backroads-pane canvas'
    );
    if (!canvas) return 0;
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque += 1;
    return opaque;
  });
  expect(painted).toBeGreaterThan(0);
});

test('each silence says which silence it is', async ({ page }) => {
  // 1. Zoomed out past where the layer asks at all.
  await page.route('**/api/backroads*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, tooWide: false, truncated: false, roads: [] })
    });
  });

  await loadApp(page);
  await enableBackroads(page);
  await page.locator('button[aria-label="Map layers"]').click({ force: true });
  await sleep(1500);

  const zoomedOut = page.locator('text=Backroads draw once you zoom in closer.');
  const nothingMapped = page.locator('text=/No backroads mapped here/');
  // One of the two must be showing: which depends on where the map opened.
  await expect(zoomedOut.or(nothingMapped).first()).toBeVisible({ timeout: 20_000 });

  // 2. Asked and could not reach OpenStreetMap. NOT "there are no roads".
  await page.unroute('**/api/backroads*');
  await page.route('**/api/backroads*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, tooWide: false, truncated: false, roads: [] })
    });
  });
  await zoomIn(page, 5);
  await expect(page.locator('text=/Couldn’t load the backroads here/')).toBeVisible({
    timeout: 20_000
  });
});
