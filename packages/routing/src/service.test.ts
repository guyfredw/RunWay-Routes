import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_KM, RateLimiter, createRouteHandler, parseRouteInput, planRoute, searchRadiusM } from './service.ts';
import type { RouteResponse, StopArea } from './service.ts';
import { StopMap, routeLength } from './stops.ts';
import type { Coord } from './stops.ts';

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
  assert.deepEqual(ok, { ok: true, value: { lat: 25.8, lon: -80.3, distanceKm: 5, type: 'loop', variant: 0 } });
  assert.equal(parseRouteInput({ lat: 95, lon: 0, distanceKm: 5, type: 'loop' }).ok, false);
  assert.equal(parseRouteInput({ lat: '25.8', lon: -80.3, distanceKm: 5, type: 'loop' }).ok, false);
  assert.equal(parseRouteInput({ lat: 25.8, lon: -80.3, distanceKm: MAX_KM + 1, type: 'loop' }).ok, false);
  assert.equal(parseRouteInput({ lat: 25.8, lon: -80.3, distanceKm: 5, type: 'zigzag' }).ok, false);
  assert.equal(parseRouteInput({ lat: 25.8, lon: -80.3, distanceKm: 5, type: 'loop', variant: 1.5 }).ok, false);
  assert.equal(parseRouteInput(null).ok, false);
});

test('loads stop data far enough out for the distance', () => {
  assert.ok(searchRadiusM(5) >= 2500 + 1000);
  assert.ok(searchRadiusM(42) > 21000);
});

test('returns an out-and-back route within 5% of the distance, with a turnaround', async () => {
  const restore = fakeBrouter();
  try {
    const r = await planRoute({ ...START, distanceKm: 5, type: 'out-and-back', variant: 0 }, emptyArea);
    assert.equal(r.status, 200);
    const body = r.body as RouteResponse;
    assert.ok(Math.abs(body.distanceM - 5000) <= 250, `distance ${body.distanceM}`);
    assert.ok(body.turnaround);
    assert.ok(body.options >= 2);
    assert.deepEqual(body.coords[0].slice(0, 2), [START.lon, START.lat]);
    assert.ok(body.warnings.some((w) => w.includes('No crossings')));
  } finally {
    restore();
  }
});

test('a redo returns a different route, and variants wrap around', async () => {
  const restore = fakeBrouter();
  try {
    const plan = (variant: number) => planRoute({ ...START, distanceKm: 5, type: 'out-and-back', variant }, emptyArea).then((r) => r.body as RouteResponse);
    const first = await plan(0);
    const second = await plan(1);
    assert.notDeepEqual(first.coords, second.coords);
    const wrapped = await plan(first.options);
    assert.equal(wrapped.variant, 0);
    assert.deepEqual(wrapped.coords, first.coords);
  } finally {
    restore();
  }
});

test('returns a loop within 5% of the distance, and warns outside the covered area', async () => {
  const restore = fakeBrouter();
  try {
    const r = await planRoute({ ...START, distanceKm: 8, type: 'loop', variant: 0 }, () => ({ map: new StopMap([]), startCovered: false }));
    assert.equal(r.status, 200);
    const body = r.body as RouteResponse;
    assert.ok(Math.abs(body.distanceM - 8000) <= 400, `distance ${body.distanceM}`);
    assert.equal(body.turnaround, null);
    assert.ok(body.warnings[0].includes('outside the area'));
  } finally {
    restore();
  }
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
    assert.equal((await handle('x'.repeat(3000), 'v')).status, 413);
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
