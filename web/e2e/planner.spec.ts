import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PLACE = { name: 'Doral, Miami-Dade County, Florida, United States', lat: 25.8195, lon: -80.3553, bbox: [25.79, 25.85, -80.40, -80.31] };

// A 5 km out-and-back running north and back. Route n has n likely stops.
function fakeOption(n: number, meetsRules = true) {
  const out = Array.from({ length: 26 }, (_, i) => [-80.3553 + n * 0.002, 25.8195 + (i * 100) / 111320, 3 + (i % 5)]);
  return {
    distanceM: 5000 + n * 10, gainM: 6,
    coords: [...out, ...out.slice(0, -1).reverse()],
    stops: [
      { lat: 25.8285, lon: -80.3553, likely: true, signal: true, wait: 'long', road: 'NW 41st St', distM: 1000 },
      { lat: 25.8240, lon: -80.3553, likely: false, signal: false, wait: 'short', distM: 500 },
    ],
    summary: { likelyStops: n, otherCrossings: 1, signals: 1, noSidewalkM: meetsRules ? 0 : 900, busyNoSidewalkM: meetsRules ? 0 : 900 },
    noSidewalk: [],
    turnaround: { lat: 25.8420, lon: -80.3553, distM: 2500 },
    meetsRules,
    warnings: meetsRules ? [] : ['Includes about 900 m on busy roads with no mapped sidewalk. Check those sections, shown as purple dashes, before you run.'],
  };
}
const fakeResponse = (page = 0, meetsRules = true) => ({
  type: 'out-and-back', page, pages: 2, meetsRules,
  options: [1, 2, 3].map((i) => fakeOption(page * 3 + i, meetsRules)),
});

const BLANK_STYLE = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef0f2' } }] };

async function setUp(page: Page, routeHandler?: (route: Route) => Promise<void>) {
  const routeBodies: Record<string, unknown>[] = [];
  await page.route('https://tiles.openfreemap.org/**', (r) => r.fulfill({ json: BLANK_STYLE }));
  await page.route('**/api/search', (r) => r.fulfill({ json: { places: [PLACE] } }));
  await page.route('**/api/route', async (r) => {
    const body = r.request().postDataJSON();
    routeBodies.push(body);
    if (routeHandler) return routeHandler(r);
    await r.fulfill({ json: fakeResponse(body.page) });
  });
  await page.goto('/');
  await expect(page.getByTestId('map')).toHaveAttribute('data-ready', 'true');
  return routeBodies;
}

async function findAndSetStart(page: Page) {
  await page.getByPlaceholder('Address, place or ZIP code').fill('Doral, FL');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect.poll(async () => Number(await page.getByTestId('map').getAttribute('data-zoom'))).toBeGreaterThanOrEqual(12);
  await page.getByTestId('map').click();
  await expect(page.getByText('Start set.')).toBeVisible();
}

test('search, set a start, compare routes, show more and download', async ({ page }) => {
  const bodies = await setUp(page);
  await expect(page.getByRole('button', { name: 'Generate route' })).toBeDisabled();
  await findAndSetStart(page);

  await page.getByRole('radio', { name: 'Out and back' }).click();
  await page.getByRole('button', { name: 'Generate route' }).click();
  await expect(page.getByTestId('distance')).toHaveText('5.01 km');
  await expect(page.getByTestId('likely-stops')).toHaveText('1');
  expect(bodies[0]).toMatchObject({ distanceKm: 5, type: 'out-and-back', page: 0 });
  expect(Math.abs((bodies[0].lat as number) - PLACE.lat)).toBeLessThan(0.05);
  expect(Math.abs((bodies[0].lon as number) - PLACE.lon)).toBeLessThan(0.05);
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.getByText('Set 1 of 2.')).toBeVisible();

  await page.getByRole('tab', { name: /Route 3/ }).click();
  await expect(page.getByTestId('likely-stops')).toHaveText('3');
  expect(bodies).toHaveLength(1); // switching routes needs no new request

  await page.getByRole('button', { name: 'Show more routes' }).click();
  await expect(page.getByText('Set 2 of 2.')).toBeVisible();
  await expect(page.getByRole('tab', { name: /Route 4/ })).toHaveAttribute('aria-selected', 'true');
  expect(bodies[1]).toMatchObject({ page: 1 });

  await page.getByRole('tab', { name: /Route 4/ }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download GPX' }).click()]);
  expect(download.suggestedFilename()).toBe('runway-5-km-out-and-back-route-4.gpx');
  const gpx = await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8'));
  expect(gpx).toContain('<name>Turnaround</name>');
  expect(gpx.match(/<trkpt /g)?.length).toBe(51);
});

test('the start point never appears in a URL', async ({ page }) => {
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  await setUp(page);
  await findAndSetStart(page);
  await page.getByRole('button', { name: 'Generate route' }).click();
  await expect(page.getByTestId('distance')).toBeVisible();
  expect(urls.filter((u) => /25\.8\d|80\.3\d|Doral/i.test(u))).toEqual([]);
});

test('closest matches are shown with what each one misses', async ({ page }) => {
  await setUp(page, (r) => r.fulfill({ json: fakeResponse(0, false) }));
  await findAndSetStart(page);
  await page.getByRole('button', { name: 'Generate route' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'closest matches' })).toBeVisible();
  await expect(page.getByText('Includes about 900 m on busy roads with no mapped sidewalk.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download GPX' })).toBeEnabled();
});

test('miles are converted and sent as kilometres', async ({ page }) => {
  const bodies = await setUp(page);
  await findAndSetStart(page);
  await page.getByRole('radio', { name: 'mi' }).click();
  await expect(page.getByLabel('Distance')).toHaveValue('3.1');
  await page.getByRole('button', { name: 'Generate route' }).click();
  await expect(page.getByTestId('distance')).toHaveText('3.11 mi');
  expect(bodies[0].distanceKm).toBeCloseTo(4.989, 2);
});

test('distances outside the range are refused before sending', async ({ page }) => {
  await setUp(page);
  await findAndSetStart(page);
  await page.getByLabel('Distance').fill('50');
  await expect(page.getByText('Choose a distance from 1 to 42 km.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate route' })).toBeDisabled();
});

test('a route the service cannot make shows its explanation', async ({ page }) => {
  await setUp(page, (r) => r.fulfill({ status: 422, json: { error: 'No route near this start point meets the rules.' } }));
  await findAndSetStart(page);
  await page.getByRole('button', { name: 'Generate route' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No route' })).toHaveText('No route near this start point meets the rules.');
  await expect(page.getByRole('button', { name: 'Download GPX' })).toHaveCount(0);
});

test('draw a route by clicking, change how it ends, undo and download', async ({ page }) => {
  const draws: { points: number[][]; shape: string }[] = [];
  await page.route('**/api/draw', async (r) => {
    const body = r.request().postDataJSON();
    draws.push(body);
    const option = fakeOption(1);
    await r.fulfill({ json: { ...option, distanceM: 1000 * body.points.length, turnaround: body.shape === 'out-and-back' ? option.turnaround : null } });
  });
  await setUp(page);
  await findAndSetStart(page); // sets a generate-mode start, which drawing should leave alone
  await page.getByRole('radio', { name: 'Draw your own' }).click();
  await expect(page.getByText('Click or tap the map to add your start')).toBeVisible();

  const map = page.getByTestId('map');
  const box = (await map.boundingBox())!;
  await map.click({ position: { x: box.width * 0.4, y: box.height * 0.4 } });
  await expect(page.getByText('Start set. Add the next point.')).toBeVisible();
  await map.click({ position: { x: box.width * 0.6, y: box.height * 0.6 } });
  await expect(page.getByTestId('distance')).toHaveText('2.00 km');
  expect(draws.at(-1)).toMatchObject({ shape: 'as-drawn' });
  expect(draws.at(-1)!.points).toHaveLength(2);

  await map.click({ position: { x: box.width * 0.6, y: box.height * 0.3 } });
  await expect(page.getByTestId('distance')).toHaveText('3.00 km');
  await page.getByRole('radio', { name: 'Out and back' }).click();
  await expect.poll(() => draws.at(-1)?.shape).toBe('out-and-back');
  await expect(page.getByText('Turnaround, also in the GPX file')).toBeVisible();

  await page.getByRole('button', { name: 'Undo point' }).click();
  await expect(page.getByTestId('distance')).toHaveText('2.00 km');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download GPX' }).click()]);
  expect(download.suggestedFilename()).toBe('runway-drawn-2-km.gpx');

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByTestId('distance')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Generate a route' }).click();
  await expect(page.getByText('Start set.')).toBeVisible();
});

test('a drawn route that cannot be joined shows why', async ({ page }) => {
  await page.route('**/api/draw', (r) => r.fulfill({ status: 422, json: { error: 'These points could not be joined along roads or paths.' } }));
  await setUp(page);
  await findAndSetStart(page);
  await page.getByRole('radio', { name: 'Draw your own' }).click();
  const map = page.getByTestId('map');
  const box = (await map.boundingBox())!;
  await map.click({ position: { x: box.width * 0.4, y: box.height * 0.4 } });
  await map.click({ position: { x: box.width * 0.6, y: box.height * 0.6 } });
  await expect(page.getByRole('alert').filter({ hasText: 'could not be joined' })).toBeVisible();
});
