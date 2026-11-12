import test from 'node:test';
import assert from 'node:assert/strict';
import { toGpx, turnaroundOf } from './gpx.ts';
import type { Coord } from './stops.ts';

const at = (m: number): Coord => [-80.34, 25.8 + m / 111320, 3];
const outAndBack: Coord[] = [at(0), at(500), at(1000), at(500), at(0)];

test('the turnaround is the middle point of an out-and-back route', () => {
  const t = turnaroundOf(outAndBack);
  assert.equal(t.name, 'Turnaround');
  assert.ok(Math.abs(t.lat - at(1000)[1]) < 1e-9);
  assert.match(t.desc!, /1\.00 km/);
});

test('waypoints come before the track, as GPX 1.1 requires', () => {
  const gpx = toGpx('Test run', outAndBack, [turnaroundOf(outAndBack)]);
  assert.ok(gpx.indexOf('<wpt') > gpx.indexOf('<metadata>'));
  assert.ok(gpx.indexOf('<wpt') < gpx.indexOf('<trk>'));
  assert.equal((gpx.match(/<trkpt /g) ?? []).length, outAndBack.length);
  assert.match(gpx, /<wpt lat="25\.808983" lon="-80\.340000"><name>Turnaround<\/name>/);
});

test('a route without waypoints has no wpt element', () => {
  assert.doesNotMatch(toGpx('Loop', outAndBack), /<wpt/);
});

test('names are escaped', () => {
  assert.match(toGpx('A & B <run>', outAndBack), /A &amp; B &lt;run&gt;/);
});
