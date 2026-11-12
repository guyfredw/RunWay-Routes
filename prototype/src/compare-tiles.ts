// Checks stop-data tiles against the prototype's Overpass download, using saved routes.
// Usage: node --max-old-space-size=4096 src/compare-tiles.ts <tile-dir>
//        node src/compare-tiles.ts <tile-dir> --memory   (tiles only, reports memory and time)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { StopMap, distM } from '../../packages/routing/src/stops.ts';
import type { Analysis, Coord, OsmElement } from '../../packages/routing/src/stops.ts';
import { TileStore } from '../../packages/routing/src/tiles.ts';

const tileDir = process.argv[2] ?? '../data/stop-tiles/florida';
const store = new TileStore(tileDir);

if (process.argv.includes('--memory')) {
  // A 16 km out-and-back can reach 8 km from its start, so load a 9 km radius.
  const start = JSON.parse(readFileSync('data/local-start.json', 'utf8')) as { lat: number; lon: number };
  const before = process.memoryUsage().rss;
  const t0 = performance.now();
  const r = store.elements({ south: start.lat - 0.081, west: start.lon - 0.09, north: start.lat + 0.081, east: start.lon + 0.09 });
  const map = new StopMap(r.elements);
  const ms = performance.now() - t0;
  console.log(`9 km radius: ${r.tiles} tiles (${r.missing} missing), ${r.elements.length.toLocaleString()} elements, ${map.ways.length.toLocaleString()} ways`);
  console.log(`Loaded in ${Math.round(ms)} ms; memory ${Math.round(before / 1048576)} MB before, ${Math.round(process.memoryUsage().rss / 1048576)} MB after`);
  process.exit(0);
}

const overpass = new StopMap(JSON.parse(readFileSync('data/doral-osm.json', 'utf8')).elements as OsmElement[]);
const files = ['output/local', 'output/gpx'].filter(existsSync).flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.gpx')).map((f) => `${d}/${f}`));
const readGpx = (f: string): Coord[] => [...readFileSync(f, 'utf8').matchAll(/<trkpt lat="([\d.-]+)" lon="([\d.-]+)"/g)].map((m) => [+m[2], +m[1]]);
const pick = (a: Analysis) => ({ likely: a.likelyStops, other: a.otherCrossings, signals: a.signals, noSidewalkM: Math.round(a.quietNoSidewalkM + a.busyNoSidewalkM), privateM: Math.round(a.privateM), gates: a.gates });

const totals = { routes: 0, same: 0, likely: [0, 0], other: [0, 0], noSidewalkM: [0, 0] };
for (const f of files) {
  const coords = readGpx(f);
  const [lon0, lat0] = coords[0];
  const radius = Math.max(...coords.map((c) => distM(lat0, lon0, c[1], c[0]))) + 500;
  const a = pick(overpass.analyze(coords));
  const b = pick(store.stopMapAround(lat0, lon0, radius).analyze(coords));
  const same = JSON.stringify(a) === JSON.stringify(b);
  totals.routes++;
  if (same) totals.same++;
  totals.likely[0] += a.likely; totals.likely[1] += b.likely;
  totals.other[0] += a.other; totals.other[1] += b.other;
  totals.noSidewalkM[0] += a.noSidewalkM; totals.noSidewalkM[1] += b.noSidewalkM;
  if (!same) console.log(`${f.split('/').pop()}\n  overpass ${JSON.stringify(a)}\n  tiles    ${JSON.stringify(b)}`);
}
console.log(`\n${totals.same} of ${totals.routes} routes identical`);
console.log(`Likely stops: ${totals.likely[0]} (Overpass, 4 Nov) vs ${totals.likely[1]} (tiles)`);
console.log(`Other crossings: ${totals.other[0]} vs ${totals.other[1]}`);
console.log(`No sign of a sidewalk (m): ${totals.noSidewalkM[0]} vs ${totals.noSidewalkM[1]}`);
