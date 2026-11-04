// Stricter checks on the test: fairer comparison, and what the routes run along.
import { readFileSync } from 'node:fs';
import { StopMap } from './stops.ts';
import type { Coord, OsmElement } from './stops.ts';
import { candidates, pickFewestStops, usable } from './generate.ts';
import type { CourseType, Request } from './generate.ts';

const STARTS = [
  { name: 'Downtown', lat: 25.8207222, lon: -80.3340548 },
  { name: 'Central', lat: 25.8025285, lon: -80.3412283 },
  { name: 'Legacy', lat: 25.8469549, lon: -80.3805876 },
];
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

const map = new StopMap(JSON.parse(readFileSync('data/doral-osm.json', 'utf8')).elements as OsmElement[]);

function surfaceShares(coords: Coord[], totals: Map<string, number>) {
  let prev: number | null = null;
  let prevIndex = 0;
  coords.forEach((c, i) => {
    const id = map.snap(c[1], c[0]);
    if (id === null) return;
    if (prev !== null && prev !== id) {
      const b = new Set(map.nodeWays.get(id) ?? []);
      const way = (map.nodeWays.get(prev) ?? []).find((w) => b.has(w));
      let len = 0;
      for (let k = prevIndex + 1; k <= i; k++) len += Math.hypot((coords[k][1] - coords[k - 1][1]) * 111320, (coords[k][0] - coords[k - 1][0]) * 100300);
      const t = way === undefined ? undefined : map.ways[way].tags;
      const h = t?.highway ?? 'unmatched';
      const busy = /^(primary|secondary|trunk)/.test(h);
      const hasSidewalk = /both|left|right|yes|separate/.test(t?.sidewalk ?? '');
      const key = busy ? `${h}${hasSidewalk ? ' (sidewalk tagged)' : ' (no sidewalk tag)'}` : h;
      totals.set(key, (totals.get(key) ?? 0) + len);
    }
    prev = id;
    prevIndex = i;
  });
}

let chosenSum = 0;
let baseMedianSum = 0;
let stopPoolMedianSum = 0;
let wins = 0;
let cases = 0;
const totals = new Map<string, number>();

for (const s of STARTS) for (const km of [5, 10, 16]) for (const type of ['out-and-back', 'loop'] as CourseType[]) {
  const req: Request = { lat: s.lat, lon: s.lon, distanceM: km * 1000, type };
  const stops = await candidates(req, 'runway-fewer-stops', map);
  const base = await candidates(req, 'runway-baseline', map);
  const chosen = pickFewestStops(stops, req);
  const baseUsable = base.filter((c) => usable(c, req)).map((c) => c.analysis.weighted);
  const stopsUsable = stops.filter((c) => usable(c, req)).map((c) => c.analysis.weighted);
  if (!chosen || !baseUsable.length) continue;
  const baseMedian = median(baseUsable);
  chosenSum += chosen.analysis.weighted;
  baseMedianSum += baseMedian;
  stopPoolMedianSum += median(stopsUsable);
  cases++;
  if (chosen.analysis.weighted <= baseMedian * 0.7) wins++;
  surfaceShares(chosen.coords, totals);
}

console.log(`Cases: ${cases}`);
console.log(`Weighted stops, chosen route: ${chosenSum}`);
console.log(`Weighted stops, median comparison route: ${baseMedianSum} (${Math.round((1 - chosenSum / baseMedianSum) * 100)}% lower)`);
console.log(`Weighted stops, median fewer-stops candidate (profile effect, no selection): ${stopPoolMedianSum} (${Math.round((1 - stopPoolMedianSum / baseMedianSum) * 100)}% lower)`);
console.log(`Cases at 30%+ below the median comparison route: ${wins}/${cases}`);
const all = [...totals.values()].reduce((a, b) => a + b, 0);
console.log('\nWhat chosen routes run along:');
for (const [k, v] of [...totals].sort((a, b) => b[1] - a[1])) console.log(`${(v / all * 100).toFixed(1).padStart(5)}%  ${k}`);
