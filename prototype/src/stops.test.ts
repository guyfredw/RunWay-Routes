import test from 'node:test';
import assert from 'node:assert/strict';
import { StopMap, retraceShare, routeLength } from './stops.ts';
import type { Coord, OsmElement } from './stops.ts';
import { cutAt } from './generate.ts';

const LON = -80.34;
const at = (m: number): [number, number] => [LON, 25.8 + m / 111320];
const east = (m: number): [number, number] => [LON + m / 100000, 25.8];

function way(id: number, nodes: [number, [number, number]][], tags: Record<string, string>): OsmElement {
  return { type: 'way', id, nodes: nodes.map(([n]) => n), geometry: nodes.map(([, p]) => ({ lon: p[0], lat: p[1] })), tags };
}

// A path running north, with a side street joining at 200 m.
const path = way(1, [[1, at(0)], [2, at(200)], [3, at(400)]], { highway: 'footway' });
const route: Coord[] = [at(0), at(200), at(400)];

test('counts a side street as a minor stop', () => {
  const a = new StopMap([path, way(2, [[2, at(200)], [10, east(200)]], { highway: 'residential' })]).analyze(route);
  assert.equal(a.minor, 1);
  assert.equal(a.total, 1);
});

test('counts a major road as a major stop', () => {
  const a = new StopMap([path, way(2, [[2, at(200)], [10, east(200)]], { highway: 'secondary' })]).analyze(route);
  assert.equal(a.major, 1);
});

test('a nearby traffic signal upgrades the stop', () => {
  const signal: OsmElement = { type: 'node', id: 2, lon: at(200)[0], lat: at(200)[1], tags: { highway: 'traffic_signals' } };
  const a = new StopMap([signal, path, way(2, [[2, at(200)], [10, east(200)]], { highway: 'residential' })]).analyze(route);
  assert.equal(a.signals, 1);
  assert.equal(a.total, 1);
});

test('ignores driveways and service roads', () => {
  const a = new StopMap([path, way(2, [[2, at(200)], [10, east(200)]], { highway: 'service' })]).analyze(route);
  assert.equal(a.total, 0);
});

test('counts a road crossed without a shared node', () => {
  const road = way(2, [[10, [LON - 0.001, 25.8 + 200 / 111320]], [11, [LON + 0.001, 25.8 + 200 / 111320]]], { highway: 'residential' });
  const a = new StopMap([way(1, [[1, at(0)], [3, at(400)]], { highway: 'footway' }), road]).analyze([at(0), at(400)]);
  assert.equal(a.minor, 1);
});

test('does not count a road passing under a bridge', () => {
  const road = way(2, [[10, [LON - 0.001, 25.8 + 200 / 111320]], [11, [LON + 0.001, 25.8 + 200 / 111320]]], { highway: 'residential' });
  const a = new StopMap([way(1, [[1, at(0)], [3, at(400)]], { highway: 'footway', bridge: 'yes' }), road]).analyze([at(0), at(400)]);
  assert.equal(a.total, 0);
});

test('an out-and-back route counts a crossing on both passes', () => {
  const a = new StopMap([path, way(2, [[2, at(200)], [10, east(200)]], { highway: 'residential' })]).analyze([at(0), at(200), at(400), at(200), at(0)]);
  assert.equal(a.minor, 2);
});

test('merges map nodes from one intersection', () => {
  const p = way(1, [[1, at(0)], [2, at(200)], [4, at(215)], [3, at(400)]], { highway: 'footway' });
  const a = new StopMap([p, way(2, [[2, at(200)], [10, east(200)]], { highway: 'residential' }), way(3, [[4, at(215)], [11, east(215)]], { highway: 'residential' })]).analyze([at(0), at(200), at(215), at(400)]);
  assert.equal(a.total, 1);
});

test('measures private road distance', () => {
  const a = new StopMap([way(1, [[1, at(0)], [2, at(200)], [3, at(400)]], { highway: 'service', access: 'private' })]).analyze(route);
  assert.ok(a.privateM > 390);
});

test('measures repeated ground', () => {
  assert.ok(Math.abs(retraceShare([at(0), at(200), at(0)]) - 0.5) < 0.01);
});

test('cuts a route at an exact distance', () => {
  assert.ok(Math.abs(routeLength(cutAt([at(0), at(1000)], 250)) - 250) < 1);
});
