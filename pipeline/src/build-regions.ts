// Downloads Geofabrik extracts one at a time and builds them into one shared tile folder.
// Usage: node pipeline/src/build-regions.ts <region-list> <osm-dir> <tile-dir>
// Regions already built (with a file in <tile-dir>/_regions) are skipped, so it can be rerun.
// Each download is deleted after its tiles are built, to save disk space; pass --keep-downloads to keep them.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [listFile, osmDir, tileDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const keepDownloads = process.argv.includes('--keep-downloads');
if (!listFile || !osmDir || !tileDir) {
  console.error('Usage: build-regions.ts <region-list> <osm-dir> <tile-dir>');
  process.exit(1);
}
const USER_AGENT = 'RunWayRoutes-pipeline (https://github.com/guyfredw/RunWay-Routes)';
const buildScript = fileURLToPath(new URL('./build-stop-tiles.ts', import.meta.url));

const ids = readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
mkdirSync(osmDir, { recursive: true });
mkdirSync(join(tileDir, '_regions'), { recursive: true });

async function regionUrls(): Promise<Map<string, string>> {
  const indexFile = join(osmDir, 'geofabrik-index-v1.json');
  if (!existsSync(indexFile)) {
    const res = await fetch('https://download.geofabrik.de/index-v1.json', { headers: { 'User-Agent': USER_AGENT } });
    writeFileSync(indexFile, Buffer.from(await res.arrayBuffer()));
  }
  const index = JSON.parse(readFileSync(indexFile, 'utf8')) as { features: { properties: { id: string; urls: { pbf: string } } }[] };
  return new Map(index.features.map((f) => [f.properties.id, f.properties.urls.pbf]));
}

async function md5Of(file: string): Promise<string> {
  const hash = createHash('md5');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function downloadOnce(url: string, file: string): Promise<void> {
  let md5 = await fetch(`${url}.md5`, { headers: { 'User-Agent': USER_AGENT } });
  if (!md5.ok) {
    // Large extracts (Germany) redirect to a mirror, which has the checksum file instead.
    const head = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
    if (head.url !== url) md5 = await fetch(`${head.url}.md5`, { headers: { 'User-Agent': USER_AGENT } });
  }
  const expected = md5.ok ? (await md5.text()).split(/\s+/)[0] : '';
  // Geofabrik briefly removes files while it publishes a new extract.
  if (!/^[0-9a-f]{32}$/.test(expected)) throw new Error(`No checksum available (${md5.status}): ${url}.md5`);
  if (existsSync(file) && (await md5Of(file)) === expected) return;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(`${file}.part`));
  renameSync(`${file}.part`, file);
  const actual = await md5Of(file);
  if (actual !== expected) {
    rmSync(file);
    throw new Error(`Checksum mismatch for ${file}: expected ${expected}, got ${actual}`);
  }
}

// Retries dropped connections and bad checksums, waiting longer each time.
async function download(url: string, file: string, attempts = 4): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadOnce(url, file);
    } catch (err) {
      if (attempt >= attempts) throw err;
      const wait = 30 * 2 ** (attempt - 1);
      console.log(`  download failed (${(err as Error).message}); retrying in ${wait} s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

const urls = await regionUrls();
const started = Date.now();
const failed: string[] = [];
for (const [i, id] of ids.entries()) {
  const name = id.replace(/\//g, '-');
  const file = join(osmDir, `${name}-latest.osm.pbf`);
  const label = `[${i + 1}/${ids.length}] ${id}`;
  if (existsSync(join(tileDir, '_regions', `${name}.json`))) {
    console.log(`${label}: already built`);
    continue;
  }
  const url = urls.get(id);
  if (!url) throw new Error(`Unknown Geofabrik region: ${id}`);
  const t0 = Date.now();
  try {
    await download(url, file);
  } catch (err) {
    console.log(`${label}: skipped, ${(err as Error).message}`);
    failed.push(id);
    continue;
  }
  const sizeMB = Math.round(statSync(file).size / 1e6);
  const r = spawnSync(process.execPath, ['--max-old-space-size=24000', buildScript, file, tileDir, '--merge'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`Build failed for ${id}`);
  }
  const summary = JSON.parse(readFileSync(join(tileDir, '_regions', `${name}.json`), 'utf8'));
  if (!keepDownloads) rmSync(file);
  const mins = ((Date.now() - started) / 60000).toFixed(0);
  console.log(`${label}: ${sizeMB} MB, ${summary.tiles} tiles (${summary.mergedTiles} merged), ${summary.peakMemoryMB} MB peak, ${Math.round((Date.now() - t0) / 1000)} s; ${mins} min so far`);
}

// Totals for the whole folder.
const tiles = readdirSync(tileDir).filter((f) => f.endsWith('.json.gz'));
// Loops, not Math.max(...list): there are too many tiles to spread into one call.
const sizes = tiles.map((f) => statSync(join(tileDir, f)).size);
const bytes = sizes.reduce((n, s) => n + s, 0);
const regions = readdirSync(join(tileDir, '_regions')).map((f) => JSON.parse(readFileSync(join(tileDir, '_regions', f), 'utf8')));
const manifest = {
  regions: regions.length,
  sourceBytes: regions.reduce((n, r) => n + r.sourceBytes, 0),
  tiles: tiles.length,
  tileBytes: bytes,
  largestTileBytes: sizes.reduce((m, s) => Math.max(m, s), 0),
  peakMemoryMB: regions.reduce((m, r) => Math.max(m, r.peakMemoryMB), 0),
  builtAt: new Date().toISOString(),
};
writeFileSync(join(tileDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(manifest);
if (failed.length) {
  console.log(`Not built: ${failed.join(', ')}. Run again later to add them.`);
  process.exitCode = 1;
}
