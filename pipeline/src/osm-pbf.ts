// A small reader for OpenStreetMap PBF files (.osm.pbf).
// It reads only what the stop-data pipeline needs: nodes with coordinates and tags,
// and ways with node references and tags. Relations are skipped.
// Format reference: https://wiki.openstreetmap.org/wiki/PBF_Format
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { PbfReader } from 'pbf';

export type OsmNode = { id: number; lat: number; lon: number; tags: Record<string, string> | null };
export type OsmWay = { id: number; refs: number[]; tags: Record<string, string> };
export type Handlers = { node?: (n: OsmNode) => void; way?: (w: OsmWay) => void };

type BlobHeader = { type: string; datasize: number };

function readBlobHeader(buf: Uint8Array): BlobHeader {
  return new PbfReader(buf).readFields((tag, h: BlobHeader, p) => {
    if (tag === 1) h.type = p.readString();
    else if (tag === 3) h.datasize = p.readVarint();
  }, { type: '', datasize: 0 });
}

function readBlob(buf: Uint8Array): Uint8Array {
  const b = new PbfReader(buf).readFields((tag, o: { raw?: Uint8Array; zlib?: Uint8Array }, p) => {
    if (tag === 1) o.raw = p.readBytes();
    else if (tag === 3) o.zlib = p.readBytes();
    else if (tag === 4 || tag === 6 || tag === 7) throw new Error('Unsupported PBF compression (only zlib and raw are supported)');
  }, {});
  if (b.raw) return b.raw;
  if (b.zlib) return inflateSync(b.zlib);
  throw new Error('Empty PBF blob');
}

type Block = { strings: string[]; granularity: number; latOffset: number; lonOffset: number; groups: Uint8Array[] };

function readBlock(buf: Uint8Array): Block {
  return new PbfReader(buf).readFields((tag, b: Block, p) => {
    if (tag === 1) p.readMessage((t, strings: string[], q) => { if (t === 1) strings.push(q.readString()); }, b.strings);
    else if (tag === 2) b.groups.push(p.readBytes());
    else if (tag === 17) b.granularity = p.readVarint();
    else if (tag === 19) b.latOffset = p.readVarint(true);
    else if (tag === 20) b.lonOffset = p.readVarint(true);
  }, { strings: [], granularity: 100, latOffset: 0, lonOffset: 0, groups: [] });
}

function tagsFrom(keys: number[], vals: number[], strings: string[]): Record<string, string> {
  const tags: Record<string, string> = {};
  for (let i = 0; i < keys.length; i++) tags[strings[keys[i]]] = strings[vals[i]];
  return tags;
}

function readGroup(buf: Uint8Array, block: Block, h: Handlers): void {
  const coord = (v: number, offset: number) => (offset + block.granularity * v) * 1e-9;
  new PbfReader(buf).readFields((tag, _: unknown, p) => {
    if (tag === 2 && h.node) {
      // Dense nodes: ids and coordinates are delta-encoded; tags are key/value pairs ending in 0.
      const d = p.readMessage((t, o: { ids: number[]; lats: number[]; lons: number[]; kv: number[] }, q) => {
        if (t === 1) q.readPackedSVarint(o.ids);
        else if (t === 8) q.readPackedSVarint(o.lats);
        else if (t === 9) q.readPackedSVarint(o.lons);
        else if (t === 10) q.readPackedVarint(o.kv);
      }, { ids: [], lats: [], lons: [], kv: [] });
      let id = 0, lat = 0, lon = 0, k = 0;
      for (let i = 0; i < d.ids.length; i++) {
        id += d.ids[i];
        lat += d.lats[i];
        lon += d.lons[i];
        let tags: Record<string, string> | null = null;
        while (k < d.kv.length && d.kv[k] !== 0) {
          (tags ??= {})[block.strings[d.kv[k]]] = block.strings[d.kv[k + 1]];
          k += 2;
        }
        k++;
        h.node({ id, lat: coord(lat, block.latOffset), lon: coord(lon, block.lonOffset), tags });
      }
    } else if (tag === 1 && h.node) {
      const n = p.readMessage((t, o: { id: number; lat: number; lon: number; keys: number[]; vals: number[] }, q) => {
        if (t === 1) o.id = q.readSVarint();
        else if (t === 2) q.readPackedVarint(o.keys);
        else if (t === 3) q.readPackedVarint(o.vals);
        else if (t === 8) o.lat = q.readSVarint();
        else if (t === 9) o.lon = q.readSVarint();
      }, { id: 0, lat: 0, lon: 0, keys: [], vals: [] });
      h.node({ id: n.id, lat: coord(n.lat, block.latOffset), lon: coord(n.lon, block.lonOffset), tags: n.keys.length ? tagsFrom(n.keys, n.vals, block.strings) : null });
    } else if (tag === 3 && h.way) {
      const w = p.readMessage((t, o: { id: number; keys: number[]; vals: number[]; refs: number[] }, q) => {
        if (t === 1) o.id = q.readVarint();
        else if (t === 2) q.readPackedVarint(o.keys);
        else if (t === 3) q.readPackedVarint(o.vals);
        else if (t === 8) q.readPackedSVarint(o.refs);
      }, { id: 0, keys: [], vals: [], refs: [] });
      let ref = 0;
      const refs = w.refs.map((r) => (ref += r));
      h.way({ id: w.id, refs, tags: tagsFrom(w.keys, w.vals, block.strings) });
    }
  }, null);
}

// Reads a whole file, calling the handlers for each node and way in file order.
export function readOsmPbf(path: string, h: Handlers, onProgress?: (done: number, total: number) => void): void {
  const fd = openSync(path, 'r');
  const total = fstatSync(fd).size;
  let pos = 0;
  const lenBuf = Buffer.alloc(4);
  try {
    while (pos < total) {
      readSync(fd, lenBuf, 0, 4, pos);
      const headerLen = lenBuf.readUInt32BE(0);
      const headerBuf = Buffer.alloc(headerLen);
      readSync(fd, headerBuf, 0, headerLen, pos + 4);
      const header = readBlobHeader(headerBuf);
      const blobBuf = Buffer.alloc(header.datasize);
      readSync(fd, blobBuf, 0, header.datasize, pos + 4 + headerLen);
      pos += 4 + headerLen + header.datasize;
      if (header.type !== 'OSMData') continue;
      const block = readBlock(readBlob(blobBuf));
      for (const g of block.groups) readGroup(g, block, h);
      onProgress?.(pos, total);
    }
  } finally {
    closeSync(fd);
  }
}
