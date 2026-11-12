// Builds stop-data tiles from an OpenStreetMap extract.
// Usage: node --max-old-space-size=16000 pipeline/src/build-stop-tiles.ts <input.osm.pbf> <output-dir> [--merge]
// With --merge, tiles already in the output folder are combined with the new ones, so
// neighbouring regions can share a folder. Ways crossing a border appear once.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { TILE_DEG, TILE_FORMAT, keepNode, keepWay, mergeTiles, pickTags, tileKey } from '../../packages/routing/src/tiles.ts';
import type { Tile, TileNode, TileWay } from '../../packages/routing/src/tiles.ts';
import { readOsmPbf } from './osm-pbf.ts';

const [input, outDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const merge = process.argv.includes('--merge');
if (!input || !outDir) {
  console.error('Usage: build-stop-tiles.ts <input.osm.pbf> <output-dir> [--merge]');
  process.exit(1);
}

const started = performance.now();
const elapsed = () => `${((performance.now() - started) / 1000).toFixed(0)} s`;
const progress = (label: string) => {
  let last = 0;
  return (done: number, total: number) => {
    const pct = Math.floor((done / total) * 100);
    if (pct >= last + 10) {
      last = pct;
      console.log(`  ${label}: ${pct}% (${elapsed()})`);
    }
  };
};

// Pass 1: keep road and path ways, and remember which nodes they use.
type Way = { id: number; start: number; count: number; tags: Record<string, string> };
const ways: Way[] = [];
let refs = new Float64Array(1 << 24);
let refCount = 0;
console.log(`Reading ways from ${input}`);
readOsmPbf(input, {
  way: (w) => {
    if (!keepWay(w.tags)) return;
    if (refCount + w.refs.length > refs.length) {
      const bigger = new Float64Array(refs.length * 2);
      bigger.set(refs);
      refs = bigger;
    }
    ways.push({ id: w.id, start: refCount, count: w.refs.length, tags: pickTags(w.tags, 'way') });
    for (const r of w.refs) refs[refCount++] = r;
  },
}, progress('ways'));

const needed = Float64Array.from(refs.subarray(0, refCount)).sort();
let unique = 0;
for (let i = 0; i < needed.length; i++) if (i === 0 || needed[i] !== needed[i - 1]) needed[unique++] = needed[i];
const nodeIds = needed.subarray(0, unique);
console.log(`Kept ${ways.length.toLocaleString()} ways using ${unique.toLocaleString()} nodes (${elapsed()})`);

const indexOf = (id: number): number => {
  let lo = 0;
  let hi = nodeIds.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = nodeIds[mid];
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
};

// Pass 2: coordinates for those nodes, plus tagged signals, crossings, stop signs and gates.
const lats = new Int32Array(unique);
const lons = new Int32Array(unique);
const found = new Uint8Array(unique);
const tagged: TileNode[] = [];
console.log('Reading nodes');
readOsmPbf(input, {
  node: (n) => {
    const i = indexOf(n.id);
    const lat = Math.round(n.lat * 1e7);
    const lon = Math.round(n.lon * 1e7);
    if (i >= 0) {
      lats[i] = lat;
      lons[i] = lon;
      found[i] = 1;
    }
    if (n.tags && keepNode(n.tags)) tagged.push([n.id, lat, lon, pickTags(n.tags, 'node')]);
  },
}, progress('nodes'));
const missingNodes = found.reduce((n, f) => n + (f ? 0 : 1), 0);
console.log(`Found coordinates for ${(unique - missingNodes).toLocaleString()} nodes, kept ${tagged.length.toLocaleString()} tagged nodes (${elapsed()})`);

// Assign ways and nodes to every tile they touch.
const buckets = new Map<string, { ways: number[]; nodes: number[] }>();
const bucket = (key: string) => {
  let b = buckets.get(key);
  if (!b) buckets.set(key, (b = { ways: [], nodes: [] }));
  return b;
};
let skippedWays = 0;
ways.forEach((w, wi) => {
  const keys = new Set<string>();
  let prev: [number, number] | null = null;
  for (let k = 0; k < w.count; k++) {
    const i = indexOf(refs[w.start + k]);
    if (i < 0 || !found[i]) continue;
    const lat = lats[i] / 1e7;
    const lon = lons[i] / 1e7;
    keys.add(tileKey(lat, lon));
    if (prev) {
      // Long segments can pass through tiles without a vertex in them.
      const steps = Math.ceil(Math.max(Math.abs(lat - prev[0]), Math.abs(lon - prev[1])) / (TILE_DEG / 2));
      for (let s = 1; s < steps; s++) keys.add(tileKey(prev[0] + ((lat - prev[0]) * s) / steps, prev[1] + ((lon - prev[1]) * s) / steps));
    }
    prev = [lat, lon];
  }
  if (keys.size === 0) skippedWays++;
  for (const key of keys) bucket(key).ways.push(wi);
});
tagged.forEach((n, ni) => bucket(tileKey(n[1] / 1e7, n[2] / 1e7)).nodes.push(ni));

// Write one gzipped JSON file per tile.
if (!merge) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
let bytes = 0;
let largest = 0;
let merged = 0;
for (const [key, b] of buckets) {
  const tileWays: TileWay[] = b.ways.map((wi) => {
    const w = ways[wi];
    const ids: number[] = [];
    const la: number[] = [];
    const lo: number[] = [];
    for (let k = 0; k < w.count; k++) {
      const id = refs[w.start + k];
      const i = indexOf(id);
      if (i < 0 || !found[i]) continue;
      ids.push(id);
      la.push(lats[i]);
      lo.push(lons[i]);
    }
    return [w.id, ids, la, lo, w.tags];
  });
  let tile: Tile = { v: TILE_FORMAT, ways: tileWays, nodes: b.nodes.map((ni) => tagged[ni]) };
  const file = join(outDir, `${key}.json.gz`);
  if (merge && existsSync(file)) {
    tile = mergeTiles(JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as Tile, tile);
    merged++;
  }
  const gz = gzipSync(JSON.stringify(tile), { level: 9 });
  writeFileSync(file, gz);
  bytes += gz.length;
  largest = Math.max(largest, gz.length);
}

const summary = {
  format: TILE_FORMAT,
  tileDegrees: TILE_DEG,
  source: input.split(/[\\/]/).pop(),
  sourceBytes: statSync(input).size,
  sourceModified: statSync(input).mtime.toISOString(),
  builtAt: new Date().toISOString(),
  ways: ways.length,
  nodes: unique,
  missingNodes,
  taggedNodes: tagged.length,
  skippedWays,
  tiles: buckets.size,
  mergedTiles: merged,
  tileBytes: bytes,
  largestTileBytes: largest,
  seconds: Math.round((performance.now() - started) / 1000),
  peakMemoryMB: Math.round(process.resourceUsage().maxRSS / 1024),
};
if (merge) {
  mkdirSync(join(outDir, '_regions'), { recursive: true });
  writeFileSync(join(outDir, '_regions', `${summary.source!.replace(/-latest\.osm\.pbf$/, '')}.json`), JSON.stringify(summary, null, 2));
} else writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(summary, null, 2));
console.log(summary);
