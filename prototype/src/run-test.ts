// Runs the Doral feasibility test and writes results, GPX files and a map viewer.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { StopMap, overlapShare } from './stops.ts';
import type { Coord, OsmElement } from './stops.ts';
import { candidates, pickDifferent, pickFewestStops, pickIgnoringStops, withinTolerance } from './generate.ts';
import type { Candidate, CourseType, Request } from './generate.ts';

const STARTS = [
  { name: 'Downtown Doral Park', lat: 25.8207222, lon: -80.3340548 },
  { name: 'Doral Central Park', lat: 25.8025285, lon: -80.3412283 },
  { name: 'Doral Legacy Park', lat: 25.8469549, lon: -80.3805876 },
];
const DISTANCES_KM = [5, 10, 16];
const TYPES: CourseType[] = ['out-and-back', 'loop'];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function toGpx(name: string, coords: Coord[]): string {
  const points = coords.map(([lon, lat, ele]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${ele !== undefined ? `<ele>${ele.toFixed(1)}</ele>` : ''}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RunWay Routes prototype" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${xml(name)}</name></metadata>\n<trk><name>${xml(name)}</name><trkseg>\n${points}\n</trkseg></trk>\n</gpx>\n`;
}

const summary = (c: Candidate | null) => c && {
  km: +(c.analysis.distanceM / 1000).toFixed(2),
  gainM: Math.round(c.analysis.gainM),
  signals: c.analysis.signals,
  long: c.analysis.long,
  medium: c.analysis.medium,
  short: c.analysis.short,
  noSidewalkM: Math.round(c.analysis.quietNoSidewalkM + c.analysis.busyNoSidewalkM),
  total: c.analysis.total,
  likelyStops: c.analysis.likelyStops,
  otherCrossings: c.analysis.otherCrossings,
  weighted: c.analysis.weighted,
  retracePct: Math.round(c.analysis.retraceShare * 100),
  matchedPct: Math.round(c.analysis.matchedShare * 100),
  privateM: Math.round(c.analysis.privateM),
  servicePct: Math.round((c.analysis.serviceM / c.analysis.distanceM) * 100),
  gates: c.analysis.gates,
};

const pct = (a: number, b: number) => (b ? Math.round((1 - a / b) * 100) : 0);

async function main() {
  console.log('Loading map data...');
  const elements = JSON.parse(readFileSync('data/doral-osm.json', 'utf8')).elements as OsmElement[];
  const map = new StopMap(elements);
  mkdirSync('output/gpx', { recursive: true });

  const results: any[] = [];
  const viewer: any[] = [];

  for (const start of STARTS) for (const km of DISTANCES_KM) for (const type of TYPES) {
    const req: Request = { lat: start.lat, lon: start.lon, distanceM: km * 1000, type };
    const t0 = performance.now();
    const stopsList = await candidates(req, 'runway-fewer-stops', map);
    const chosen = pickFewestStops(stopsList, req);
    const seconds = (performance.now() - t0) / 1000;
    const baseList = await candidates(req, 'runway-baseline', map);
    const base = pickIgnoringStops(baseList, req);
    const another = chosen && pickDifferent(stopsList, chosen, req);

    const label = `${start.name} ${km}km ${type}`;
    const row = {
      label, start: start.name, km, type,
      seconds: +seconds.toFixed(1),
      candidates: stopsList.length,
      inTolerance: stopsList.filter((c) => withinTolerance(c, req)).length,
      runway: summary(chosen),
      baseline: summary(base),
      weightedReductionPct: chosen && base ? pct(chosen.analysis.weighted, base.analysis.weighted) : null,
      totalReductionPct: chosen && base ? pct(chosen.analysis.total, base.analysis.total) : null,
      another: another ? { weighted: another.analysis.weighted, overlapPct: Math.round(overlapShare(another.coords, chosen!.coords) * 100) } : null,
    };
    results.push(row);
    console.log(`${label}: ${seconds.toFixed(1)}s, stops ${row.runway?.total ?? '-'} vs ${row.baseline?.total ?? '-'}, weighted ${row.runway?.weighted ?? '-'} vs ${row.baseline?.weighted ?? '-'} (${row.weightedReductionPct ?? '-'}%)`);

    if (chosen) {
      writeFileSync(`output/gpx/${slug(label)}.gpx`, toGpx(`RunWay ${km}km ${type}`, chosen.coords));
      viewer.push({
        label, start,
        runway: { coords: chosen.coords.map((c) => [c[0], c[1]]), events: chosen.analysis.events, noSidewalk: chosen.analysis.noSidewalk, stats: row.runway },
        baseline: base && { coords: base.coords.map((c) => [c[0], c[1]]), stats: row.baseline },
      });
    }
  }

  writeFileSync('output/results.json', JSON.stringify(results, null, 2));
  const template = readFileSync('src/viewer.html', 'utf8');
  writeFileSync('output/viewer.html', template.replace('/*DATA*/null', JSON.stringify(viewer)));

  const ok = results.filter((r) => r.runway && r.baseline);
  const sum = (f: (r: any) => number) => ok.reduce((n, r) => n + f(r), 0);
  const secs = results.map((r) => r.seconds).sort((a, b) => a - b);
  console.log('\n=== SUMMARY ===');
  console.log(`Cases: ${results.length}, with a usable route: ${results.filter((r) => r.runway).length}, compared: ${ok.length}`);
  console.log(`Candidates within 5%: ${results.reduce((n, r) => n + r.inTolerance, 0)}/${results.reduce((n, r) => n + r.candidates, 0)}`);
  console.log(`Total stops: ${sum((r) => r.runway.total)} vs ${sum((r) => r.baseline.total)} (${pct(sum((r) => r.runway.total), sum((r) => r.baseline.total))}% fewer)`);
  console.log(`Likely stops: ${sum((r) => r.runway.likelyStops)} vs ${sum((r) => r.baseline.likelyStops)}`);
  console.log(`Signals: ${sum((r) => r.runway.signals)} vs ${sum((r) => r.baseline.signals)}`);
  console.log(`Long waits: ${sum((r) => r.runway.long)} vs ${sum((r) => r.baseline.long)}`);
  console.log(`Road with no sign of a sidewalk (m): ${sum((r) => r.runway.noSidewalkM)} vs ${sum((r) => r.baseline.noSidewalkM)}`);
  console.log(`Weighted: ${sum((r) => r.runway.weighted)} vs ${sum((r) => r.baseline.weighted)} (${pct(sum((r) => r.runway.weighted), sum((r) => r.baseline.weighted))}% lower)`);
  console.log(`Cases at 30%+ weighted reduction: ${ok.filter((r) => r.weightedReductionPct >= 30).length}/${ok.length}`);
  console.log(`Generation seconds: median ${secs[Math.floor(secs.length / 2)]}, max ${secs.at(-1)}`);
  console.log(`Different second route available: ${results.filter((r) => r.another).length}/${results.length}`);
  console.log(`Chosen routes with private distance or gates: ${ok.filter((r) => r.runway.privateM > 0 || r.runway.gates > 0).length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
