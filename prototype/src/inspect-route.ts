// Lists the map ways a GPX route follows, for manual review.
import { readFileSync } from 'node:fs';
import { StopMap } from './stops.ts';
import type { Coord } from './stops.ts';
const map = new StopMap(JSON.parse(readFileSync('data/doral-osm.json', 'utf8')).elements);
for (const file of process.argv.slice(2)) {
  const gpx = readFileSync(file, 'utf8');
  const coords: Coord[] = [...gpx.matchAll(/lat="([\d.-]+)" lon="([\d.-]+)"/g)].map((m) => [+m[2], +m[1]]);
  const half = file.includes('out-and-back') ? coords.slice(0, Math.ceil(coords.length / 2)) : coords;
  console.log(`\n${file}`);
  let prev: number | null = null;
  const rows: { k: string; m: number }[] = [];
  let prevC = half[0];
  for (const c of half) {
    const id = map.snap(c[1], c[0]);
    if (id === null) continue;
    if (prev !== null && prev !== id) {
      const b = new Set(map.nodeWays.get(id) ?? []);
      const w = (map.nodeWays.get(prev) ?? []).find((x) => b.has(x));
      const t = w === undefined ? {} : map.ways[w].tags ?? {};
      const k = [t.highway ?? 'unmatched', t.name, t.service && `service=${t.service}`, t.footway && `footway=${t.footway}`, t.sidewalk && `sidewalk=${t.sidewalk}`, t.access && `access=${t.access}`, t.foot && `foot=${t.foot}`, t.surface].filter(Boolean).join(' | ');
      const m = Math.hypot((c[1] - prevC[1]) * 111320, (c[0] - prevC[0]) * 100300);
      if (rows.at(-1)?.k === k) rows.at(-1)!.m += m; else rows.push({ k, m });
    }
    prev = id; prevC = c;
  }
  for (const r of rows.filter((r) => r.m >= 80)) console.log(`${String(Math.round(r.m)).padStart(5)} m  ${r.k}`);
}
