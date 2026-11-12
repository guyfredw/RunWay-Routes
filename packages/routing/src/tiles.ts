// Stop data split into small map tiles, so the server loads only the area around a route.
// The pipeline writes tiles with encodeTile; the route service reads them with TileStore.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { StopMap } from './stops.ts';
import type { OsmElement } from './stops.ts';

export const TILE_DEG = 0.05; // about 5.5 km north to south
export const TILE_FORMAT = 1;

// Only the tags the stop counter and sidewalk checks use.
const WAY_TAGS = ['highway', 'name', 'lanes', 'sidewalk', 'footway', 'crossing', 'crossing:signals', 'oneway', 'access', 'foot', 'service', 'bridge', 'tunnel'];
const NODE_TAGS = ['highway', 'crossing', 'crossing:signals', 'barrier', 'access', 'foot'];
const SKIP_HIGHWAYS = new Set(['proposed', 'construction', 'abandoned', 'platform', 'bus_stop', 'rest_area', 'services', 'elevator', 'razed', 'disused']);
const NODE_KINDS = new Set(['traffic_signals', 'crossing', 'stop', 'give_way']);

export function tileKey(lat: number, lon: number): string {
  return `${Math.floor(lat / TILE_DEG)}_${Math.floor(lon / TILE_DEG)}`;
}

export function keepWay(tags: Record<string, string>): boolean {
  return !!tags.highway && !SKIP_HIGHWAYS.has(tags.highway);
}

export function keepNode(tags: Record<string, string>): boolean {
  return NODE_KINDS.has(tags.highway ?? '') || tags.barrier === 'gate' || !!tags.crossing;
}

export function pickTags(tags: Record<string, string>, kind: 'way' | 'node'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of kind === 'way' ? WAY_TAGS : NODE_TAGS) if (tags[k] !== undefined) out[k] = tags[k];
  return out;
}

// Compact tile layout: coordinates as integers (degrees x 1e7), tags already filtered.
export type TileWay = [id: number, nodes: number[], lats: number[], lons: number[], tags: Record<string, string>];
export type TileNode = [id: number, lat: number, lon: number, tags: Record<string, string>];
export type Tile = { v: number; ways: TileWay[]; nodes: TileNode[] };

export function decodeTile(tile: Tile): OsmElement[] {
  if (tile.v !== TILE_FORMAT) throw new Error(`Unsupported stop tile format ${tile.v}`);
  const out: OsmElement[] = [];
  for (const [id, lat, lon, tags] of tile.nodes) out.push({ type: 'node', id, lat: lat / 1e7, lon: lon / 1e7, tags });
  for (const [id, nodes, lats, lons, tags] of tile.ways) {
    out.push({ type: 'way', id, nodes, geometry: lats.map((la, i) => ({ lat: la / 1e7, lon: lons[i] / 1e7 })), tags });
  }
  return out;
}

export type Bounds = { south: number; west: number; north: number; east: number };

export function boundsAround(lat: number, lon: number, radiusM: number): Bounds {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon };
}

export function tileKeysFor(b: Bounds): string[] {
  const keys: string[] = [];
  for (let r = Math.floor(b.south / TILE_DEG); r <= Math.floor(b.north / TILE_DEG); r++) {
    for (let c = Math.floor(b.west / TILE_DEG); c <= Math.floor(b.east / TILE_DEG); c++) keys.push(`${r}_${c}`);
  }
  return keys;
}

// Reads tiles from a folder of <key>.json.gz files, keeping recently used ones in memory.
export class TileStore {
  private cache = new Map<string, OsmElement[]>();
  readonly dir: string;
  readonly maxTiles: number;

  constructor(dir: string, maxTiles = 64) {
    this.dir = dir;
    this.maxTiles = maxTiles;
  }

  tile(key: string): OsmElement[] {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const file = join(this.dir, `${key}.json.gz`);
    const elements = existsSync(file) ? decodeTile(JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as Tile) : [];
    this.cache.set(key, elements);
    if (this.cache.size > this.maxTiles) this.cache.delete(this.cache.keys().next().value!);
    return elements;
  }

  // All elements in the tiles covering an area. Ways that cross tile edges appear once.
  elements(b: Bounds): { elements: OsmElement[]; tiles: number; missing: number } {
    const seen = new Set<string>();
    const elements: OsmElement[] = [];
    let missing = 0;
    const keys = tileKeysFor(b);
    for (const key of keys) {
      if (!existsSync(join(this.dir, `${key}.json.gz`))) missing++;
      for (const e of this.tile(key)) {
        const id = `${e.type}/${e.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        elements.push(e);
      }
    }
    return { elements, tiles: keys.length, missing };
  }

  stopMapAround(lat: number, lon: number, radiusM: number): StopMap {
    return this.areaAround(lat, lon, radiusM).map;
  }

  // Stop data around a start point, and whether the start itself has data.
  // Tiles with no roads are never written, so a missing start tile means the area isn't covered.
  areaAround(lat: number, lon: number, radiusM: number): { map: StopMap; startCovered: boolean } {
    return {
      map: new StopMap(this.elements(boundsAround(lat, lon, radiusM)).elements),
      startCovered: existsSync(join(this.dir, `${tileKey(lat, lon)}.json.gz`)),
    };
  }
}

// Combines two versions of the same tile, as built from neighbouring regions.
// A way in both keeps the longer node list; extracts usually include complete ways.
export function mergeTiles(a: Tile, b: Tile): Tile {
  const ways = new Map<number, TileWay>();
  for (const w of [...a.ways, ...b.ways]) {
    const prev = ways.get(w[0]);
    if (!prev || w[1].length > prev[1].length) ways.set(w[0], w);
  }
  const nodes = new Map<number, TileNode>();
  for (const n of [...a.nodes, ...b.nodes]) nodes.set(n[0], n);
  return { v: TILE_FORMAT, ways: [...ways.values()], nodes: [...nodes.values()] };
}
