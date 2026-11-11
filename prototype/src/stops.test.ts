import test from 'node:test';
import assert from 'node:assert/strict';
import { StopMap, lanesOf, retraceShare, routeLength, weightOf } from './stops.ts';
import type { Coord, OsmElement } from './stops.ts';
import { cutAt } from './generate.ts';

const LON = -80.34;
const at = (m: number): [number, number] => [LON, 25.8 + m / 111320];
const east = (m: number): [number, number] => [LON + m / 100000, 25.8];
const offsetEast = (northM: number, eastM: number): [number, number] => [LON + eastM / 100300, 25.8 + northM / 111320];

function way(id: number, nodes: [number, [number, number]][], tags: Record<string, string>): OsmElement {
  return { type: 'way', id, nodes: nodes.map(([n]) => n), geometry: nodes.map(([, p]) => ({ lon: p[0], lat: p[1] })), tags };
}

// A path running north, with a side road joining at 200 m.
const path = way(1, [[1, at(0)], [2, at(200)], [3, at(400)]], { highway: 'footway' });
const route: Coord[] = [at(0), at(200), at(400)];
const sideRoad = (tags: Record<string, string>) => way(2, [[2, at(200)], [10, east(200)]], tags);

test('a two-lane side street is a short wait', () => {
  const a = new StopMap([path, sideRoad({ highway: 'residential', lanes: '2' })]).analyze(route);
  assert.equal(a.short, 1);
  assert.equal(a.total, 1);
  assert.equal(a.weighted, 0.5);
  assert.equal(a.likelyStops, 0);
  assert.equal(a.otherCrossings, 1);
});

test('a four-lane road is a medium wait', () => {
  const a = new StopMap([path, sideRoad({ highway: 'secondary', lanes: '4' })]).analyze(route);
  assert.equal(a.medium, 1);
});

test('a six-lane road is a long wait', () => {
  const a = new StopMap([path, sideRoad({ highway: 'primary', lanes: '6' })]).analyze(route);
  assert.equal(a.long, 1);
  assert.equal(a.weighted, 5);
});

test('road type stands in when lanes are missing', () => {
  assert.equal(lanesOf({ highway: 'primary' }), 4);
  assert.equal(lanesOf({ highway: 'residential' }), 2);
  assert.equal(lanesOf({ highway: 'secondary', lanes: '3;2' }), 3);
});

test('a traffic signal adds weight to the wait', () => {
  const signal: OsmElement = { type: 'node', id: 2, lon: at(200)[0], lat: at(200)[1], tags: { highway: 'traffic_signals' } };
  const a = new StopMap([signal, path, sideRoad({ highway: 'primary', lanes: '6' })]).analyze(route);
  assert.equal(a.signals, 1);
  assert.equal(a.total, 1);
  assert.equal(a.weighted, weightOf(6, true));
  assert.ok(weightOf(6, true) > weightOf(6, false) && weightOf(6, true) > weightOf(2, true));
});

test('a crosswalk takes the width of the road it crosses', () => {
  const crossing = way(5, [[20, at(150)], [21, at(170)]], { highway: 'footway', footway: 'crossing' });
  const road = way(6, [[21, at(170)], [30, east(170)]], { highway: 'secondary', lanes: '6' });
  const p = way(1, [[1, at(0)], [20, at(150)]], { highway: 'footway' });
  const a = new StopMap([p, crossing, road]).analyze([at(0), at(150), at(170)]);
  assert.equal(a.long, 1);
});

test('ignores driveways and service roads', () => {
  const a = new StopMap([path, sideRoad({ highway: 'service' })]).analyze(route);
  assert.equal(a.total, 0);
});

test('counts a road crossed without a shared node', () => {
  const road = way(2, [[10, [LON - 0.001, 25.8 + 200 / 111320]], [11, [LON + 0.001, 25.8 + 200 / 111320]]], { highway: 'residential' });
  const a = new StopMap([way(1, [[1, at(0)], [3, at(400)]], { highway: 'footway' }), road]).analyze([at(0), at(400)]);
  assert.equal(a.short, 1);
});

test('does not count a road passing under a bridge', () => {
  const road = way(2, [[10, [LON - 0.001, 25.8 + 200 / 111320]], [11, [LON + 0.001, 25.8 + 200 / 111320]]], { highway: 'residential' });
  const a = new StopMap([way(1, [[1, at(0)], [3, at(400)]], { highway: 'footway', bridge: 'yes' }), road]).analyze([at(0), at(400)]);
  assert.equal(a.total, 0);
});

test('an out-and-back route counts a crossing on both passes', () => {
  const a = new StopMap([path, sideRoad({ highway: 'residential' })]).analyze([at(0), at(200), at(400), at(200), at(0)]);
  assert.equal(a.short, 2);
});

test('merges map nodes from one intersection, keeping the widest road', () => {
  const p = way(1, [[1, at(0)], [2, at(200)], [4, at(215)], [3, at(400)]], { highway: 'footway' });
  const a = new StopMap([p, way(2, [[2, at(200)], [10, east(200)]], { highway: 'residential' }), way(3, [[4, at(215)], [11, east(215)]], { highway: 'primary', lanes: '6' })]).analyze([at(0), at(200), at(215), at(400)]);
  assert.equal(a.total, 1);
  assert.equal(a.long, 1);
});

test('a traffic signal is a likely stop, even on a narrow road', () => {
  const signal: OsmElement = { type: 'node', id: 2, lon: at(200)[0], lat: at(200)[1], tags: { highway: 'traffic_signals' } };
  const a = new StopMap([signal, path, sideRoad({ highway: 'residential', lanes: '2' })]).analyze(route);
  assert.equal(a.likelyStops, 1);
  assert.equal(a.otherCrossings, 0);
});

test('an unsignalled road of 5 or more lanes is a likely stop', () => {
  const a = new StopMap([path, sideRoad({ highway: 'primary', lanes: '5' })]).analyze(route);
  assert.equal(a.likelyStops, 1);
});

test('an unsignalled four-lane crosswalk is a crossing, not a likely stop', () => {
  const a = new StopMap([path, sideRoad({ highway: 'secondary', lanes: '4' })]).analyze(route);
  assert.equal(a.likelyStops, 0);
  assert.equal(a.otherCrossings, 1);
});

test('signals outweigh unsignalled crossings of the same width', () => {
  assert.ok(weightOf(4, true) > weightOf(4, false) * 3);
  assert.ok(weightOf(2, false) < 1);
});

// A divided road: two one-way halves with the same name, 40 m apart.
const half = (id: number, node: number, northM: number, lanes: string, name = 'Big Road', westbound = false) => {
  const ends: [number, [number, number]][] = [[node, at(northM)], [node + 100, offsetEast(northM, 100)]];
  return way(id, westbound ? ends.reverse() : ends, { highway: 'primary', oneway: 'yes', lanes, name });
};
const longPath = way(1, [[1, at(0)], [2, at(200)], [3, at(240)], [4, at(400)]], { highway: 'footway' });
const crossBoth: Coord[] = [at(0), at(200), at(240), at(400)];

test('both halves of a divided road count as one crossing', () => {
  const a = new StopMap([longPath, half(2, 2, 200, '3'), half(3, 3, 240, '3', 'Big Road', true)]).analyze(crossBoth);
  assert.equal(a.total, 1);
  assert.equal(a.long, 1); // 3 + 3 lanes
});

test('a wide intersection with several crossings in a row is one stop', () => {
  const p = way(1, [[1, at(0)], [2, at(200)], [3, at(220)], [4, at(240)], [5, at(255)], [6, at(400)]], { highway: 'footway' });
  const roads = [2, 3, 4, 5].map((n, i) => way(10 + i, [[n, at([200, 220, 240, 255][i])], [100 + n, east([200, 220, 240, 255][i])]], { highway: 'residential' }));
  const a = new StopMap([p, ...roads]).analyze([at(0), at(200), at(220), at(240), at(255), at(400)]);
  assert.equal(a.total, 1);
});

test('crossings spread over more than 60 m become separate stops', () => {
  const marks = [200, 230, 260, 290];
  const p = way(1, [[1, at(0)], ...marks.map((m, i) => [2 + i, at(m)] as [number, [number, number]]), [9, at(400)]], { highway: 'footway' });
  const roads = marks.map((m, i) => way(10 + i, [[2 + i, at(m)], [100 + i, east(m)]], { highway: 'residential' }));
  const a = new StopMap([p, ...roads]).analyze([at(0), ...marks.map(at), at(400)]);
  assert.equal(a.total, 2);
});

test('two different roads 40 m apart stay separate stops', () => {
  const a = new StopMap([longPath, half(2, 2, 200, '3', 'Road A'), half(3, 3, 240, '3', 'Road B', true)]).analyze(crossBoth);
  assert.equal(a.total, 2);
  assert.equal(a.medium, 2);
});

test('pieces of one half of a road do not add up', () => {
  // One eastbound half, split into two map pieces at the crossing point.
  const p1 = way(2, [[50, offsetEast(200, -100)], [2, at(200)]], { highway: 'primary', oneway: 'yes', lanes: '2', name: 'Big Road' });
  const p2 = way(3, [[2, at(200)], [51, offsetEast(200, 100)]], { highway: 'primary', oneway: 'yes', lanes: '2', name: 'Big Road' });
  const a = new StopMap([path, p1, p2]).analyze(route);
  assert.equal(a.total, 1);
  assert.equal(a.short, 1);
});

test('the same divided road crossed again later counts again', () => {
  const a = new StopMap([longPath, half(2, 2, 200, '3'), half(3, 3, 240, '3', 'Big Road', true)]).analyze([...crossBoth, at(240), at(200), at(0)]);
  assert.equal(a.total, 2);
});

// Running along a road for 400 m.
const roadRoute: Coord[] = [at(0), at(100), at(200), at(300), at(400)];
const runRoad = (tags: Record<string, string>) => way(7, [[40, at(0)], [41, at(100)], [42, at(200)], [43, at(300)], [44, at(400)]], tags);

test('flags a road with no sign of a sidewalk', () => {
  const a = new StopMap([runRoad({ highway: 'residential' })]).analyze(roadRoute);
  assert.ok(a.quietNoSidewalkM > 390);
  assert.ok(a.sidewalkPenalty > 3.9);
  assert.equal(a.noSidewalk.length, 1);
});

test('a footpath alongside the road counts as a sidewalk', () => {
  const alongside = way(8, [[50, offsetEast(0, 10)], [51, offsetEast(400, 10)]], { highway: 'footway', footway: 'sidewalk' });
  const a = new StopMap([runRoad({ highway: 'residential' }), alongside]).analyze(roadRoute);
  assert.equal(a.quietNoSidewalkM, 0);
});

test('a footpath far from the road does not count', () => {
  const farAway = way(8, [[50, offsetEast(0, 60)], [51, offsetEast(400, 60)]], { highway: 'footway' });
  const a = new StopMap([runRoad({ highway: 'residential' }), farAway]).analyze(roadRoute);
  assert.ok(a.quietNoSidewalkM > 390);
});

test('a sidewalk tag counts as a sidewalk', () => {
  const a = new StopMap([runRoad({ highway: 'residential', sidewalk: 'both' })]).analyze(roadRoute);
  assert.equal(a.quietNoSidewalkM, 0);
});

test('a wider road with no sidewalk is penalized more', () => {
  const narrow = new StopMap([runRoad({ highway: 'residential', lanes: '2' })]).analyze(roadRoute);
  const wide = new StopMap([runRoad({ highway: 'residential', lanes: '4' })]).analyze(roadRoute);
  assert.ok(wide.sidewalkPenalty > narrow.sidewalkPenalty);
});

test('a busy road with no sidewalk counts toward the busy-road limit', () => {
  const a = new StopMap([runRoad({ highway: 'tertiary', lanes: '4' })]).analyze(roadRoute);
  assert.ok(a.busyNoSidewalkM > 390);
  assert.equal(a.quietNoSidewalkM, 0);
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
