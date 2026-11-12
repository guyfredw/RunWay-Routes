// Generates routes from one private start point in data/local-start.json.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { StopMap, distM, overlapShare } from './stops.ts';
import type { Coord, OsmElement } from './stops.ts';
import { candidates, pickDifferent, pickFewestStops, pickIgnoringStops, usable } from './generate.ts';
import type { Candidate, CourseType, Request } from './generate.ts';
import { toGpx, turnaroundOf } from './gpx.ts';

const start = JSON.parse(readFileSync('data/local-start.json', 'utf8')) as { lat: number; lon: number };
const map = new StopMap(JSON.parse(readFileSync('data/doral-osm.json', 'utf8')).elements as OsmElement[]);
const SEEDS = [0, 10, 20];

const stats = (c: Candidate) => ({
  km: +(c.analysis.distanceM / 1000).toFixed(2), total: c.analysis.total, likelyStops: c.analysis.likelyStops, otherCrossings: c.analysis.otherCrossings, signals: c.analysis.signals, long: c.analysis.long, medium: c.analysis.medium, short: c.analysis.short, weighted: c.analysis.weighted,
  noSidewalkM: Math.round(c.analysis.quietNoSidewalkM + c.analysis.busyNoSidewalkM),
  retracePct: Math.round(c.analysis.retraceShare * 100), servicePct: +(c.analysis.serviceM / c.analysis.distanceM * 100).toFixed(1), busyPct: +(c.analysis.busyNoSidewalkM / c.analysis.distanceM * 100).toFixed(1),
  farthestKm: +(Math.max(...c.coords.map((p) => distM(start.lat, start.lon, p[1], p[0]))) / 1000).toFixed(1),
  startGapM: Math.round(distM(start.lat, start.lon, c.coords[0][1], c.coords[0][0])),
});

mkdirSync('output/local', { recursive: true });
// Remove routes from earlier runs, so a route that no longer meets the rules doesn't linger.
for (const f of readdirSync('output/local')) if (f.endsWith('.gpx')) rmSync(`output/local/${f}`);
const viewer: any[] = [];
const rows: any[] = [];
for (const km of [5, 10, 16]) for (const type of ['out-and-back', 'loop'] as CourseType[]) {
  const req: Request = { lat: start.lat, lon: start.lon, distanceM: km * 1000, type };
  const all: Candidate[] = [];
  const base: Candidate[] = [];
  for (const seed of SEEDS) {
    all.push(...await candidates(req, 'runway-fewer-stops', map, seed));
    base.push(...await candidates(req, 'runway-baseline', map, seed));
  }
  const chosen = pickFewestStops(all, req);
  const compare = pickIgnoringStops(base, req);
  const other = chosen && pickDifferent(all, chosen, req);
  const label = `${km}km ${type}`;
  rows.push({ label, candidates: all.length, usable: all.filter((c) => usable(c, req)).length, chosen: chosen && stats(chosen), compare: compare && stats(compare), other: other && { ...stats(other), overlapPct: Math.round(overlapShare(other.coords, chosen!.coords) * 100) } });
  console.log(label, JSON.stringify(rows.at(-1)));
  for (const [suffix, c] of [['', chosen], [' option 2', other]] as [string, Candidate | null][]) {
    if (!c) continue;
    const name = `RunWay ${km}km ${type}${suffix}`;
    writeFileSync(`output/local/${name.toLowerCase().replace(/ /g, '-')}.gpx`, toGpx(name, c.coords, type === 'out-and-back' ? [turnaroundOf(c.coords)] : []));
    viewer.push({ label: `${label}${suffix}`, start, runway: { coords: c.coords.map((p) => [p[0], p[1]]), events: c.analysis.events, noSidewalk: c.analysis.noSidewalk, turnaround: type === 'out-and-back' ? turnaroundOf(c.coords) : null, stats: stats(c) }, baseline: !suffix && compare ? { coords: compare.coords.map((p) => [p[0], p[1]]), stats: stats(compare) } : null });
  }
}
writeFileSync('output/local/results.json', JSON.stringify(rows, null, 2));
writeFileSync('output/local/viewer.html', readFileSync('src/viewer.html', 'utf8').replace('/*DATA*/null', JSON.stringify(viewer)));
