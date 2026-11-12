import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { PbfWriter } from 'pbf';
import { readOsmPbf } from './osm-pbf.ts';
import type { OsmNode, OsmWay } from './osm-pbf.ts';

// Builds a tiny .osm.pbf file: a header block, then one data block with
// three dense nodes (one tagged) and one way.
function writeBlob(type: string, payload: Uint8Array, zlib: boolean): Buffer {
  const blob = new PbfWriter();
  if (zlib) {
    blob.writeVarintField(2, payload.length);
    blob.writeBytesField(3, deflateSync(payload));
  } else blob.writeBytesField(1, payload);
  const blobBytes = blob.finish();
  const header = new PbfWriter();
  header.writeStringField(1, type);
  header.writeVarintField(3, blobBytes.length);
  const headerBytes = header.finish();
  const len = Buffer.alloc(4);
  len.writeUInt32BE(headerBytes.length);
  return Buffer.concat([len, Buffer.from(headerBytes), Buffer.from(blobBytes)]);
}

function sampleFile(zlib: boolean): string {
  const strings = ['', 'highway', 'traffic_signals', 'footway', 'name', 'Test Path'];
  const block = new PbfWriter();
  block.writeMessage(1, (_: unknown, p: PbfWriter) => strings.forEach((s) => p.writeStringField(1, s)), null);
  block.writeMessage(2, (_: unknown, g: PbfWriter) => {
    g.writeMessage(2, (_2: unknown, d: PbfWriter) => {
      // ids 101, 102, 103 and coordinates in units of 100 nanodegrees, all delta-encoded
      d.writePackedSVarint(1, [101, 1, 1]);
      d.writePackedSVarint(8, [258000000, 1000, 1000]);
      d.writePackedSVarint(9, [-803400000, 0, 0]);
      d.writePackedVarint(10, [0, 1, 2, 0, 0]); // node 102 has highway=traffic_signals
    }, null);
  }, null);
  block.writeMessage(2, (_: unknown, g: PbfWriter) => {
    g.writeMessage(3, (_2: unknown, w: PbfWriter) => {
      w.writeVarintField(1, 7);
      w.writePackedVarint(2, [1, 4]);
      w.writePackedVarint(3, [3, 5]);
      w.writePackedSVarint(8, [101, 1, 1]);
    }, null);
  }, null);
  const dir = mkdtempSync(join(tmpdir(), 'osm-pbf-'));
  const file = join(dir, 'sample.osm.pbf');
  writeFileSync(file, Buffer.concat([writeBlob('OSMHeader', new Uint8Array(), zlib), writeBlob('OSMData', block.finish(), zlib)]));
  return file;
}

for (const zlib of [false, true]) {
  test(`reads dense nodes and ways (${zlib ? 'zlib' : 'raw'} blocks)`, () => {
    const file = sampleFile(zlib);
    const nodes: OsmNode[] = [];
    const ways: OsmWay[] = [];
    readOsmPbf(file, { node: (n) => nodes.push(n), way: (w) => ways.push(w) });
    rmSync(file, { force: true });
    assert.deepEqual(nodes.map((n) => n.id), [101, 102, 103]);
    assert.ok(Math.abs(nodes[0].lat - 25.8) < 1e-9);
    assert.ok(Math.abs(nodes[2].lat - 25.8002) < 1e-9);
    assert.ok(Math.abs(nodes[0].lon + 80.34) < 1e-9);
    assert.equal(nodes[0].tags, null);
    assert.deepEqual(nodes[1].tags, { highway: 'traffic_signals' });
    assert.deepEqual(ways, [{ id: 7, refs: [101, 102, 103], tags: { highway: 'footway', name: 'Test Path' } }]);
  });
}
