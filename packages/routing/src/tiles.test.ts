import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { TILE_FORMAT, TileStore, boundsAround, decodeTile, keepNode, keepWay, mergeTiles, pickTags, tileKey, tileKeysFor } from './tiles.ts';
import type { Tile } from './tiles.ts';

const E7 = 1e7;
const crosswalkWay = (lat: number): Tile['ways'][number] => [7, [1, 2], [Math.round(lat * E7), Math.round((lat + 0.0002) * E7)], [-803400000, -803400000], { highway: 'footway', footway: 'crossing' }];

function writeTiles(tiles: Record<string, Tile>): string {
  const dir = mkdtempSync(join(tmpdir(), 'stop-tiles-'));
  for (const [key, tile] of Object.entries(tiles)) writeFileSync(join(dir, `${key}.json.gz`), gzipSync(JSON.stringify(tile)));
  return dir;
}

test('tile keys follow 0.05 degree squares', () => {
  assert.equal(tileKey(25.83, -80.38), '516_-1608');
  assert.equal(tileKey(25.8, -80.34), '516_-1607');
});

test('an area covers every tile it touches', () => {
  const keys = tileKeysFor({ south: 25.79, west: -80.36, north: 25.81, east: -80.33 });
  assert.deepEqual(keys, ['515_-1608', '515_-1607', '516_-1608', '516_-1607']);
  const b = boundsAround(25.8, -80.34, 1000);
  assert.ok(b.north - b.south > 0.017 && b.north - b.south < 0.019);
});

test('keeps road ways and stop-related nodes only', () => {
  assert.ok(keepWay({ highway: 'residential' }));
  assert.ok(!keepWay({ highway: 'construction' }));
  assert.ok(!keepWay({ building: 'yes' }));
  assert.ok(keepNode({ highway: 'traffic_signals' }));
  assert.ok(keepNode({ barrier: 'gate' }));
  assert.ok(!keepNode({ amenity: 'cafe' }));
  assert.deepEqual(pickTags({ highway: 'primary', lanes: '4', surface: 'asphalt', name: 'Main' }, 'way'), { highway: 'primary', lanes: '4', name: 'Main' });
});

test('decodes a tile into map elements', () => {
  const elements = decodeTile({ v: TILE_FORMAT, ways: [crosswalkWay(25.8)], nodes: [[1, 258000000, -803400000, { highway: 'crossing' }]] });
  assert.equal(elements.length, 2);
  const way = elements.find((e) => e.type === 'way')!;
  assert.deepEqual(way.geometry![0], { lat: 25.8, lon: -80.34 });
  assert.throws(() => decodeTile({ v: 99, ways: [], nodes: [] }));
});

test('a way in two tiles is loaded once, and missing tiles are counted', () => {
  const tile: Tile = { v: TILE_FORMAT, ways: [crosswalkWay(25.8499)], nodes: [] };
  const dir = writeTiles({ '516_-1607': tile, '517_-1607': tile });
  try {
    const store = new TileStore(dir);
    const r = store.elements({ south: 25.84, west: -80.345, north: 25.86, east: -80.341 });
    assert.equal(r.tiles, 2);
    assert.equal(r.missing, 0);
    assert.equal(r.elements.filter((e) => e.type === 'way').length, 1);
    const wider = store.elements({ south: 25.84, west: -80.355, north: 25.86, east: -80.341 });
    assert.equal(wider.tiles, 4);
    assert.equal(wider.missing, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the store keeps only the most recently used tiles in memory', () => {
  const tile: Tile = { v: TILE_FORMAT, ways: [], nodes: [] };
  const dir = writeTiles({ a: tile, b: tile, c: tile });
  try {
    const store = new TileStore(dir, 2);
    store.tile('a');
    store.tile('b');
    store.tile('a');
    store.tile('c');
    const cached = [...(store as unknown as { cache: Map<string, unknown> }).cache.keys()];
    assert.deepEqual(cached, ['a', 'c']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merging tiles from two regions keeps each way and node once', () => {
  const a: Tile = { v: TILE_FORMAT, ways: [[7, [1, 2], [1, 2], [1, 2], { highway: 'footway' }]], nodes: [[1, 1, 1, { highway: 'crossing' }]] };
  const b: Tile = { v: TILE_FORMAT, ways: [[7, [1, 2, 3], [1, 2, 3], [1, 2, 3], { highway: 'footway' }], [8, [4, 5], [4, 5], [4, 5], { highway: 'residential' }]], nodes: [[1, 1, 1, { highway: 'crossing' }], [9, 9, 9, { barrier: 'gate' }]] };
  const m = mergeTiles(a, b);
  assert.equal(m.ways.length, 2);
  assert.deepEqual(m.ways.find((w) => w[0] === 7)![1], [1, 2, 3]);
  assert.equal(m.nodes.length, 2);
});
