import test from 'node:test';
import assert from 'node:assert/strict';
import { END_NEARBY_M, endNearby, findNearSpurs, finishLoop, repeatShare, spurM, trimSpurs } from './generate.ts';
import type { Candidate, Request } from './generate.ts';
import { distM, retraceShare, routeLength } from './stops.ts';
import type { Coord } from './stops.ts';

// Points on a grid of roughly 100 m steps east (x) and north (y) of a made-up start.
const LAT = 25.83;
const LON = -80.38;
const at = (x: number, y: number): Coord => [LON + (x * 100) / (111320 * Math.cos((LAT * Math.PI) / 180)), LAT + (y * 100) / 110540];
const path = (...xy: [number, number][]) => xy.map(([x, y]) => at(x, y));
const loopReq = (distanceM: number, endNearbyM = 0): Request => ({ lat: LAT, lon: LON, distanceM, type: 'loop', endNearbyM });

test('trims an out-and-back spur from a loop', () => {
  // A square loop with a 300 m dead end off its east side.
  const withSpur = path([0, 0], [5, 0], [5, 2], [6, 2], [7, 2], [8, 2], [7, 2], [6, 2], [5, 2], [5, 5], [0, 5], [0, 0]);
  const trimmed = trimSpurs(withSpur);
  assert.deepEqual(trimmed, path([0, 0], [5, 0], [5, 2], [5, 5], [0, 5], [0, 0]));
  assert.equal(retraceShare(trimmed), 0);
  assert.ok(retraceShare(withSpur) > 0.1);
});

test('trims spurs whose tip is a point given twice, and spurs on spurs', () => {
  const tipTwice = path([0, 0], [3, 0], [3, 1], [3, 1], [3, 0], [6, 0], [6, 6], [0, 6], [0, 0]);
  assert.deepEqual(trimSpurs(tipTwice), path([0, 0], [3, 0], [6, 0], [6, 6], [0, 6], [0, 0]));
  const branched = path([0, 0], [4, 0], [4, 2], [5, 2], [4, 2], [4, 3], [4, 2], [4, 0], [8, 0], [8, 8], [0, 8], [0, 0]);
  assert.deepEqual(trimSpurs(branched), path([0, 0], [4, 0], [8, 0], [8, 8], [0, 8], [0, 0]));
});

test('leaves a loop with no spurs alone, including the shared way out and home', () => {
  const lollipop = path([0, 0], [0, 3], [4, 3], [4, 7], [0, 7], [0, 3], [0, 0]);
  assert.deepEqual(trimSpurs(lollipop), lollipop);
});

test('ending nearby drops the repeated way home', () => {
  const lollipop = path([0, 0], [0, 3], [4, 3], [4, 7], [0, 7], [0, 3], [0, 0]);
  const out = endNearby(lollipop, loopReq(routeLength(lollipop), END_NEARBY_M));
  assert.deepEqual(out, path([0, 0], [0, 3], [4, 3], [4, 7], [0, 7], [0, 3]));
  // Exact finish keeps the whole loop.
  assert.deepEqual(endNearby(lollipop, loopReq(routeLength(lollipop))), lollipop);
});

test('ending nearby stops at the distance asked for when that spot is close to the start', () => {
  const square = path([0, 0], [6, 0], [6, 6], [0, 6], [0, 0]); // 2.4 km
  const out = endNearby(square, loopReq(2000, END_NEARBY_M));
  assert.ok(Math.abs(routeLength(out) - 2000) < 1, `length ${routeLength(out)}`);
  const end = out[out.length - 1];
  assert.ok(distM(end[1], end[0], LAT, LON) <= END_NEARBY_M);
});

test('ending nearby never finishes farther from the start than allowed', () => {
  const square = path([0, 0], [6, 0], [6, 6], [0, 6], [0, 0]);
  // Stopping at 1.2 km would end 850 m away, past the limit, so it keeps going toward the start.
  const out = endNearby(square, loopReq(1200, END_NEARBY_M));
  const end = out[out.length - 1];
  assert.ok(distM(end[1], end[0], LAT, LON) <= END_NEARBY_M);
});

test('finishing a loop trims spurs before choosing the end', () => {
  const raw = path([0, 0], [5, 0], [5, 2], [8, 2], [5, 2], [5, 5], [0, 5], [0, 0]);
  assert.deepEqual(finishLoop(raw, loopReq(2000)), path([0, 0], [5, 0], [5, 2], [5, 5], [0, 5], [0, 0]));
});

// East 400 m on the north side of a divided road, across at the end, and back 12 m to the south.
const parallelSpur = path([0, 4], [0, 1], [4, 1], [4, 0.88], [0, 0.88], [-3, 0.88], [-3, 4], [0, 4]);

test('finds a spur that comes back on the other side of the road', () => {
  const spurs = findNearSpurs(parallelSpur);
  assert.equal(spurs.length, 1);
  assert.ok(spurs[0].lengthM >= 700 && spurs[0].lengthM <= 820, `length ${spurs[0].lengthM}`);
  const tip = spurs[0].tip.at;
  const [tipLon, tipLat] = at(4, 0.94);
  assert.ok(distM(tip[1], tip[0], tipLat, tipLon) < 30);
});

test('a square loop has no spurs', () => {
  assert.equal(findNearSpurs(path([0, 0], [6, 0], [6, 6], [0, 6], [0, 0])).length, 0);
});

test('spurs on parallel sidewalks count as repeated ground on loops', () => {
  const analysis = { distanceM: routeLength(parallelSpur), retraceShare: 0 } as Candidate['analysis'];
  const c: Candidate = { coords: parallelSpur, analysis, bearing: 0, spurM: spurM(parallelSpur) };
  assert.ok(repeatShare(c, loopReq(2000)) > 0.25);
  assert.equal(repeatShare(c, { ...loopReq(2000), type: 'out-and-back' }), 0);
});
