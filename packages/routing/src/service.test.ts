import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DRAW_POINTS, MAX_KM, PER_PAGE, RateLimiter, createDrawHandler, createRouteHandler, parseDrawInput, parseRouteInput, planDrawn, planRoute, rankRoutes, ruleBreakM, searchRadiusM } from './service.ts';
import type { RouteOption, RouteResponse, StopArea } from './service.ts';
import { StopMap, routeLength } from './stops.ts';
import type { Analysis, Coord } from './stops.ts';
import type { Candidate, Request } from './generate.ts';

const START = { lat: 25.83, lon: -80.38 };
const emptyArea = (): StopArea => ({ map: new StopMap([]), startCovered: true });

// A stand-in for BRouter: straight lines between the requested points, with a point every ~20 m.
function fakeBrouter(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const lonlats = decodeURIComponent(new URL(url).searchParams.get('lonlats')!).split('|').map((p) => p.split(',').map(Number));
    const coords: Coord[] = [];
    for (let i = 1; i < lonlats.length; i++) {
      const [aLon, aLat] = lonlats[i - 1];
      const [bLon, bLat] = lonlats[i];
      const steps = Math.max(1, Math.ceil(routeLength([[aLon, aLat], [bLon, bLat]]) / 20));
      for (let s = i === 1 ? 0 : 1; s <= steps; s++) coords.push([aLon + ((bLon - aLon) * s) / steps, aLat + ((bLat - aLat) * s) / steps, 2]);
    }
    return new Response(JSON.stringify({ features: [{ geometry: { coordinates: coords } }] }));
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

test('accepts a valid request and rejects bad ones', () => {
  const ok = parseRouteInput({ lat: 25.8, lon: -80.3, distanceKm: 5, type: 'loop' });
  assert.deepEqual(ok, { ok: true, value: { lat: 25.8, lon: -80.3, distanceKm: 5, type: 'loop', page: 0 } });
  assert.equal(parseRouteInput({ lat: 95, lon: 0, distanceKm: 5, type: 'loop' }).ok, false);
  assert.equal(parseRouteInput({ lat: '25.8', lon: -80.3, distanceKm: 5, type: 'loop' }).ok, false);
  assert.equal(parseRouteInput({ lat: 25.8, lon: -80.3, distanceKm: MAX_KM + 1, type: 'loop' }).ok, false);
  assert.equal(parseRouteInput({ lat: 25.8, lon: -80.3, distanceKm: 5, type: 'zigzag' }).ok, false);
  assert.equal(parseRouteInput({ lat: 25.8, lon: -80.3, distanceKm: 5, type: 'loop', page: 1.5 }).ok, false);
  assert.equal(parseRouteInput(null).ok, false);
});

test('loads stop data far enough out for the distance', () => {
  assert.ok(searchRadiusM(5) >= 2500 + 1000);
  assert.ok(searchRadiusM(42) > 21000);
});

test('returns three out-and-back routes within 5% of the distance, with turnarounds', async () => {
  const restore = fakeBrouter();
  try {
    const r = await planRoute({ ...START, distanceKm: 5, type: 'out-and-back', page: 0 }, emptyArea);
    assert.equal(r.status, 200);
    const body = r.body as RouteResponse;
    assert.equal(body.meetsRules, true);
    assert.equal(body.options.length, PER_PAGE);
    for (const o of body.options) {
      assert.ok(Math.abs(o.distanceM - 5000) <= 250, `distance ${o.distanceM}`);
      assert.ok(o.turnaround);
      assert.ok(o.meetsRules);
      assert.deepEqual(o.coords[0].slice(0, 2), [START.lon, START.lat]);
    }
    assert.notDeepEqual(body.options[0].coords, body.options[1].coords);
    assert.ok(body.options[0].warnings.some((w) => w.includes('No crossings')));
  } finally {
    restore();
  }
});

test('more routes come in pages, which wrap around', async () => {
  const restore = fakeBrouter();
  try {
    const plan = (page: number) => planRoute({ ...START, distanceKm: 5, type: 'out-and-back', page }, emptyArea).then((r) => r.body as RouteResponse);
    const first = await plan(0);
    assert.ok(first.pages >= 2);
    const second = await plan(1);
    assert.equal(second.page, 1);
    assert.notDeepEqual(first.options[0].coords, second.options[0].coords);
    const wrapped = await plan(first.pages);
    assert.equal(wrapped.page, 0);
    assert.deepEqual(wrapped.options[0].coords, first.options[0].coords);
  } finally {
    restore();
  }
});

test('returns a loop within 5% of the distance, and warns outside the covered area', async () => {
  const restore = fakeBrouter();
  try {
    const r = await planRoute({ ...START, distanceKm: 8, type: 'loop', page: 0 }, () => ({ map: new StopMap([]), startCovered: false }));
    assert.equal(r.status, 200);
    const route = (r.body as RouteResponse).options[0];
    assert.ok(Math.abs(route.distanceM - 8000) <= 400, `distance ${route.distanceM}`);
    assert.equal(route.turnaround, null);
    assert.ok(route.warnings[0].includes('outside the area'));
  } finally {
    restore();
  }
});

// A made-up candidate route: straight north for `length` metres, with the given analysis figures.
function fake(bearing: number, figures: Partial<Analysis>, lengthM = 32000): Candidate {
  const coords: Coord[] = Array.from({ length: 50 }, (_, i) => [-80.38 + bearing * 0.01, 25.83 + (i * lengthM) / 49 / 111320]);
  const analysis = {
    distanceM: lengthM, gainM: 0, events: [], signals: 0, long: 0, medium: 0, short: 0, total: 0, likelyStops: 0, otherCrossings: 0, weighted: 0,
    privateM: 0, serviceM: 0, serviceNearEndsM: 0, busyNoSidewalkM: 0, quietNoSidewalkM: 0, sidewalkPenalty: 0, noSidewalk: [], gates: 0, retraceShare: 0, matchedShare: 1,
    ...figures,
  } as Analysis;
  return { coords, bearing, analysis };
}
const longRun: Request = { lat: 25.83, lon: -80.38, distanceM: 32000, type: 'out-and-back' };

test('when no route meets every rule, the closest matches come first', () => {
  const list = [
    fake(1, { busyNoSidewalkM: 3000 }),
    fake(2, { busyNoSidewalkM: 1400 }),
    fake(3, { privateM: 50 }), // never allowed
    fake(4, { busyNoSidewalkM: 900 }, 29500), // 7.8% short: 900 m busy is 310 m over the limit, plus 900 m of missed distance
    fake(5, { busyNoSidewalkM: 1400, gates: 1 }), // never allowed
    fake(6, {}, 27000), // more than 10% short
  ];
  const { routes, meetsRules } = rankRoutes(list, longRun);
  assert.equal(meetsRules, false);
  assert.deepEqual(routes.map((c) => c.bearing), [2, 4, 1]);
  assert.ok(Math.abs(ruleBreakM(list[1], longRun) - (1400 - 640)) < 1);
});

test('closest matches with similar rule-breaking distances are ranked by stops', () => {
  const manyStops = fake(1, { busyNoSidewalkM: 1410, weighted: 200 });
  const fewStops = fake(2, { busyNoSidewalkM: 1447, weighted: 90 });
  const { routes } = rankRoutes([manyStops, fewStops], longRun);
  assert.deepEqual(routes.map((c) => c.bearing), [2, 1]);
});

test('routes that meet every rule are shown alone, without closest matches', () => {
  const { routes, meetsRules } = rankRoutes([fake(1, { busyNoSidewalkM: 1400 }), fake(2, { busyNoSidewalkM: 100 })], longRun);
  assert.equal(meetsRules, true);
  assert.deepEqual(routes.map((c) => c.bearing), [2]);
});

test('the rate limiter allows a set number per window', () => {
  const limiter = new RateLimiter(2, 60_000);
  assert.ok(limiter.take('a', 0).ok);
  assert.ok(limiter.take('a', 1000).ok);
  const blocked = limiter.take('a', 2000);
  assert.deepEqual(blocked, { ok: false, retryAfterS: 58 });
  assert.ok(limiter.take('b', 2000).ok);
  assert.ok(limiter.take('a', 61_000).ok);
});

test('the handler checks input, limits visitors and reports routing failures', async () => {
  const restore = fakeBrouter();
  try {
    const handle = createRouteHandler({ areaAround: emptyArea, perMinute: 1 });
    const body = JSON.stringify({ ...START, distanceKm: 3, type: 'out-and-back' });
    assert.equal((await handle('x'.repeat(9000), 'v')).status, 413);
    assert.equal((await handle('not json', 'v')).status, 400);
    assert.equal((await handle(JSON.stringify({ lat: 1 }), 'v')).status, 400);
    assert.equal((await handle(body, 'v')).status, 200);
    const limited = await handle(body, 'v');
    assert.equal(limited.status, 429);
    assert.ok(limited.headers?.['Retry-After']);
    globalThis.fetch = (async () => { throw new Error('connection refused'); }) as typeof fetch;
    const failed = await handle(body, 'other');
    assert.equal(failed.status, 502);
    assert.ok(!JSON.stringify(failed.body).includes('25.83'));
  } finally {
    restore();
  }
});

test('the handler turns visitors away while it is busy', async () => {
  const waiting: (() => void)[] = [];
  const release = () => { for (const r of waiting.splice(0)) r(); };
  const real = globalThis.fetch;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { waiting.push(() => resolve(new Response('{}'))); })) as typeof fetch;
  try {
    const handle = createRouteHandler({ areaAround: emptyArea, maxBusy: 1 });
    const body = JSON.stringify({ ...START, distanceKm: 3, type: 'out-and-back' });
    const first = handle(body, 'a');
    const second = await handle(body, 'b');
    assert.equal(second.status, 503);
    release();
    globalThis.fetch = (async () => new Response('{}')) as typeof fetch;
    assert.equal((await first).status, 422);
  } finally {
    globalThis.fetch = real;
  }
});

const P1: [number, number] = [25.83, -80.38];
const P2: [number, number] = [25.84, -80.38]; // about 1.1 km north
const P3: [number, number] = [25.84, -80.37];

test('checks drawn points', () => {
  assert.deepEqual(parseDrawInput({ points: [P1, P2] }), { ok: true, value: { points: [P1, P2], shape: 'as-drawn' } });
  assert.equal(parseDrawInput({ points: [P1] }).ok, false);
  assert.equal(parseDrawInput({ points: [P1, [95, 0]] }).ok, false);
  assert.equal(parseDrawInput({ points: [P1, ['25.8', -80.3]] }).ok, false);
  assert.equal(parseDrawInput({ points: [P1, P2], shape: 'zigzag' }).ok, false);
  assert.equal(parseDrawInput({ points: Array.from({ length: MAX_DRAW_POINTS + 1 }, () => P1) }).ok, false);
  assert.equal(parseDrawInput({ points: [P1, [26.5, -80.38]] }).ok, false); // about 75 km across
});

test('joins drawn points, and can close the loop or come back the same way', async () => {
  const restore = fakeBrouter();
  try {
    const draw = (shape: 'as-drawn' | 'loop' | 'out-and-back') => planDrawn({ points: [P1, P2, P3], shape }, emptyArea).then((r) => ({ status: r.status, route: r.body as RouteOption }));
    const asDrawn = await draw('as-drawn');
    assert.equal(asDrawn.status, 200);
    assert.ok(Math.abs(asDrawn.route.distanceM - 2110) < 60, `distance ${asDrawn.route.distanceM}`);
    assert.equal(asDrawn.route.turnaround, null);
    assert.ok(asDrawn.route.meetsRules);

    const loop = await draw('loop');
    const last = loop.route.coords.at(-1)!;
    assert.deepEqual([last[1], last[0]], P1);
    assert.ok(loop.route.distanceM > asDrawn.route.distanceM + 1000);

    const back = await draw('out-and-back');
    assert.ok(Math.abs(back.route.distanceM - 2 * asDrawn.route.distanceM) < 2);
    assert.ok(back.route.turnaround);
  } finally {
    restore();
  }
});

test('a drawn route that cannot be joined explains why', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response('not found', { status: 400 })) as typeof fetch;
  try {
    const r = await planDrawn({ points: [P1, P2], shape: 'as-drawn' }, emptyArea);
    assert.equal(r.status, 422);
    assert.ok((r.body as { error: string }).error.includes('Move the last point'));
  } finally {
    globalThis.fetch = real;
  }
});

test('drawing allows many more requests than generating', async () => {
  const restore = fakeBrouter();
  try {
    const handle = createDrawHandler({ areaAround: emptyArea });
    const body = JSON.stringify({ points: [P1, P2] });
    for (let i = 0; i < 20; i++) assert.equal((await handle(body, 'v')).status, 200);
  } finally {
    restore();
  }
});
