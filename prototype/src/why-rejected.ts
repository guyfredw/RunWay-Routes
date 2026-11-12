// Counts which rule rejects each candidate route. Usage: node src/why-rejected.ts [start.json] km type
import { readFileSync } from 'node:fs';
import { TileStore } from '../../packages/routing/src/tiles.ts';
import { candidates, withinTolerance, MAX_BUSY_SHARE, MAX_LOOP_RETRACE, MAX_SERVICE_SHARE } from '../../packages/routing/src/generate.ts';
import type { CourseType, Request } from '../../packages/routing/src/generate.ts';
import { searchRadiusM } from '../../packages/routing/src/service.ts';

const [startFile, km, type] = process.argv.slice(2);
const start = startFile === '-' ? { lat: 25.8195, lon: -80.3553 } : JSON.parse(readFileSync(startFile, 'utf8'));
const req: Request = { lat: start.lat, lon: start.lon, distanceM: Number(km) * 1000, type: type as CourseType };
const { map } = new TileStore(process.env.STOP_TILES ?? '../data/stop-tiles/launch').areaAround(start.lat, start.lon, searchRadiusM(Number(km)));
const reasons: Record<string, number> = {};
let n = 0;
for (const seed of [0, 15, 7.5, 22.5]) for (const c of await candidates(req, 'runway-fewer-stops', map, seed)) {
  n++;
  const a = c.analysis;
  const why = [
    !withinTolerance(c, req) && 'distance',
    (a.privateM > 0 || a.gates > 0) && 'private/gate',
    (a.serviceM - a.serviceNearEndsM) / a.distanceM > MAX_SERVICE_SHARE && 'service',
    a.busyNoSidewalkM / a.distanceM > MAX_BUSY_SHARE && 'busy-no-sidewalk',
    req.type === 'loop' && a.retraceShare > MAX_LOOP_RETRACE && 'retrace',
  ].filter(Boolean);
  const key = why.length ? why.join('+') : 'usable';
  reasons[key] = (reasons[key] ?? 0) + 1;
}
console.log(`${km} km ${type}: ${n} candidates`, reasons);
