// Estimates likely running stops along a route using OpenStreetMap data.
// Levels: signal (traffic lights), major (marked crossing or major road), minor (side street).

export type Coord = [lon: number, lat: number, ele?: number];
export type Level = 'signal' | 'major' | 'minor';
export type StopEvent = { distM: number; lat: number; lon: number; level: Level; reason: string };

export type OsmElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  geometry?: ({ lat: number; lon: number } | null)[];
  tags?: Record<string, string>;
};

export type Analysis = {
  distanceM: number;
  gainM: number;
  events: StopEvent[];
  signals: number;
  major: number;
  minor: number;
  total: number;
  weighted: number;
  privateM: number;
  serviceM: number;
  busyNoSidewalkM: number;
  gates: number;
  retraceShare: number;
  matchedShare: number;
};

export const WEIGHTS: Record<Level, number> = { signal: 5, major: 3, minor: 1 };
const RANK: Record<Level, number> = { minor: 1, major: 2, signal: 3 };
const CLUSTER_M = 35;
const SIGNAL_NEAR_M = 20;
const SNAP_M = 3;
const CELL = 0.001;

const M_PER_DEG = 111320;

export function distM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

export function routeLength(coords: Coord[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += distM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  return total;
}

export function elevationGain(coords: Coord[], thresholdM = 3): number {
  let gain = 0;
  let anchor: number | undefined;
  for (const c of coords) {
    const e = c[2];
    if (e === undefined) continue;
    if (anchor === undefined || e < anchor) anchor = e;
    else if (e - anchor >= thresholdM) {
      gain += e - anchor;
      anchor = e;
    }
  }
  return gain;
}

function roadClass(tags: Record<string, string> | undefined): 'major' | 'minor' | null {
  const h = tags?.highway ?? '';
  if (/^(primary|secondary|tertiary|trunk)(_link)?$/.test(h)) return 'major';
  if (/^(residential|unclassified|living_street)$/.test(h)) return 'minor';
  return null;
}

const isSignalNode = (t?: Record<string, string>) => t?.highway === 'traffic_signals' || t?.crossing === 'traffic_signals' || t?.crossing === 'pedestrian_signals';
const isSeparatedLevel = (t?: Record<string, string>) => !!t && ((t.bridge && t.bridge !== 'no') || (t.tunnel && t.tunnel !== 'no'));
const isPrivate = (t?: Record<string, string>) => !!t && (t.access === 'private' || t.access === 'no' || t.foot === 'no' || t.foot === 'private');

const isBusyNoSidewalk = (t?: Record<string, string>) => /^(primary|secondary|trunk)(_link)?$/.test(t?.highway ?? '') && !/both|left|right|yes|separate/.test(t?.sidewalk ?? '');

function segmentsCross(aLat: number, aLon: number, bLat: number, bLon: number, cLat: number, cLon: number, dLat: number, dLon: number): boolean {
  const o = (pLat: number, pLon: number, qLat: number, qLon: number, rLat: number, rLon: number) => (qLon - pLon) * (rLat - pLat) - (qLat - pLat) * (rLon - pLon);
  const d1 = o(cLat, cLon, dLat, dLon, aLat, aLon);
  const d2 = o(cLat, cLon, dLat, dLon, bLat, bLon);
  const d3 = o(aLat, aLon, bLat, bLon, cLat, cLon);
  const d4 = o(aLat, aLon, bLat, bLon, dLat, dLon);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

type Node = { lat: number; lon: number; tags?: Record<string, string> };
type RoadSeg = { way: number; aLat: number; aLon: number; bLat: number; bLon: number };

export class StopMap {
  ways: OsmElement[] = [];
  nodes = new Map<number, Node>();
  nodeWays = new Map<number, number[]>();
  nodeGrid = new Map<string, number[]>();
  roadSegGrid = new Map<string, RoadSeg[]>();
  signalGrid = new Map<string, Node[]>();

  constructor(elements: OsmElement[]) {
    for (const e of elements) {
      if (e.type !== 'node' || e.lat === undefined || e.lon === undefined) continue;
      this.nodes.set(e.id, { lat: e.lat, lon: e.lon, tags: e.tags });
      if (isSignalNode(e.tags)) push(this.signalGrid, cellKey(e.lat, e.lon), { lat: e.lat, lon: e.lon });
    }
    for (const e of elements) {
      if (e.type !== 'way' || !e.nodes || !e.geometry) continue;
      const wayIndex = this.ways.push(e) - 1;
      const cls = roadClass(e.tags);
      const separated = isSeparatedLevel(e.tags);
      e.nodes.forEach((id, i) => {
        const g = e.geometry![i];
        if (!g) return;
        if (!this.nodes.has(id)) this.nodes.set(id, { lat: g.lat, lon: g.lon });
        if (!this.nodeWays.has(id)) {
          this.nodeWays.set(id, []);
          push(this.nodeGrid, cellKey(g.lat, g.lon), id);
        }
        this.nodeWays.get(id)!.push(wayIndex);
        const next = e.geometry![i + 1];
        if (cls && !separated && next) {
          const seg = { way: wayIndex, aLat: g.lat, aLon: g.lon, bLat: next.lat, bLon: next.lon };
          for (const key of cellsForBox(g.lat, g.lon, next.lat, next.lon)) push(this.roadSegGrid, key, seg);
        }
      });
    }
  }

  snap(lat: number, lon: number): number | null {
    let best: number | null = null;
    let bestD = SNAP_M;
    const r = Math.floor(lat / CELL);
    const c = Math.floor(lon / CELL);
    for (let i = r - 1; i <= r + 1; i++) for (let j = c - 1; j <= c + 1; j++) {
      for (const id of this.nodeGrid.get(`${i}:${j}`) ?? []) {
        const n = this.nodes.get(id)!;
        const d = Math.hypot((n.lat - lat) * M_PER_DEG, (n.lon - lon) * M_PER_DEG * Math.cos(lat * Math.PI / 180));
        if (d < bestD) { bestD = d; best = id; }
      }
    }
    return best;
  }

  nearSignal(lat: number, lon: number): boolean {
    const r = Math.floor(lat / CELL);
    const c = Math.floor(lon / CELL);
    for (let i = r - 1; i <= r + 1; i++) for (let j = c - 1; j <= c + 1; j++) {
      for (const n of this.signalGrid.get(`${i}:${j}`) ?? []) if (distM(lat, lon, n.lat, n.lon) <= SIGNAL_NEAR_M) return true;
    }
    return false;
  }

  analyze(coords: Coord[]): Analysis {
    const cum: number[] = [0];
    for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + distM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);

    const matched: { i: number; id: number }[] = [];
    coords.forEach((c, i) => {
      const id = this.snap(c[1], c[0]);
      if (id !== null && matched.at(-1)?.id !== id) matched.push({ i, id });
    });

    const shared = (a: number, b: number) => {
      const wb = new Set(this.nodeWays.get(b) ?? []);
      return (this.nodeWays.get(a) ?? []).filter((w) => wb.has(w));
    };

    const raw: StopEvent[] = [];
    const add = (i: number, level: Level, reason: string) => {
      const lat = coords[i][1];
      const lon = coords[i][0];
      const upgraded: Level = level !== 'signal' && this.nearSignal(lat, lon) ? 'signal' : level;
      raw.push({ distM: cum[i], lat, lon, level: upgraded, reason });
    };

    let gates = 0;
    let privateM = 0;
    let serviceM = 0;
    let busyNoSidewalkM = 0;
    const traversedAt: Set<number>[] = [];

    for (let k = 0; k < matched.length; k++) {
      const { i, id } = matched[k];
      const before = k > 0 ? shared(matched[k - 1].id, id) : [];
      const after = k + 1 < matched.length ? shared(id, matched[k + 1].id) : [];
      const traversed = new Set([...before, ...after]);
      traversedAt[k] = traversed;
      const tags = this.nodes.get(id)?.tags;
      const onRoad = [...traversed].some((w) => roadClass(this.ways[w].tags));

      if (tags?.barrier === 'gate') gates++;
      if (isSignalNode(tags)) add(i, 'signal', 'traffic signal');
      else if (tags?.highway === 'crossing' && !onRoad) add(i, tags.crossing === 'unmarked' ? 'minor' : 'major', 'crossing');

      if (traversed.size > 0) {
        for (const w of this.nodeWays.get(id) ?? []) {
          if (traversed.has(w)) continue;
          const cls = roadClass(this.ways[w].tags);
          if (cls) add(i, cls, `${this.ways[w].tags?.highway} road`);
        }
      }

      if (k + 1 < matched.length) {
        const segLen = cum[matched[k + 1].i] - cum[i];
        const crossing = after.map((w) => this.ways[w]).find((w) => w.tags?.footway === 'crossing');
        if (crossing) {
          const t = crossing.tags!;
          const signalled = t.crossing === 'traffic_signals' || t['crossing:signals'] === 'yes';
          const crossesRealRoad = (crossing.nodes ?? []).some((n) => (this.nodeWays.get(n) ?? []).some((w) => roadClass(this.ways[w].tags)));
          add(i, signalled ? 'signal' : crossesRealRoad ? 'major' : 'minor', 'crosswalk');
        }
        if (after.length > 0 && after.every((w) => isPrivate(this.ways[w].tags))) privateM += segLen;
        if (after.length > 0 && after.every((w) => this.ways[w].tags?.highway === 'service')) serviceM += segLen;
        if (after.length > 0 && after.every((w) => isBusyNoSidewalk(this.ways[w].tags))) busyNoSidewalkM += segLen;
      }
    }

    // Roads crossed without a shared map node, such as disconnected sidewalks.
    let m = 0;
    for (let i = 1; i < coords.length; i++) {
      while (m + 1 < matched.length && matched[m + 1].i <= i) m++;
      const local = new Set<number>();
      for (let k = Math.max(0, m - 2); k <= Math.min(matched.length - 1, m + 2); k++) for (const w of traversedAt[k] ?? []) local.add(w);
      if ([...local].some((w) => isSeparatedLevel(this.ways[w].tags))) continue;
      const a = coords[i - 1];
      const b = coords[i];
      const seen = new Set<RoadSeg>();
      for (const key of cellsForBox(a[1], a[0], b[1], b[0])) {
        for (const s of this.roadSegGrid.get(key) ?? []) {
          if (seen.has(s) || local.has(s.way)) continue;
          seen.add(s);
          if (segmentsCross(a[1], a[0], b[1], b[0], s.aLat, s.aLon, s.bLat, s.bLon)) {
            const cls = roadClass(this.ways[s.way].tags)!;
            add(i, cls, `${this.ways[s.way].tags?.highway} road, no shared node`);
          }
        }
      }
    }

    const events = cluster(raw);
    const signals = events.filter((e) => e.level === 'signal').length;
    const major = events.filter((e) => e.level === 'major').length;
    const minor = events.filter((e) => e.level === 'minor').length;

    return {
      distanceM: cum.at(-1) ?? 0,
      gainM: elevationGain(coords),
      events,
      signals,
      major,
      minor,
      total: events.length,
      weighted: signals * WEIGHTS.signal + major * WEIGHTS.major + minor * WEIGHTS.minor,
      privateM,
      serviceM,
      busyNoSidewalkM,
      gates,
      retraceShare: retraceShare(coords),
      matchedShare: coords.length ? matched.length / coords.length : 0,
    };
  }
}

export function cluster(raw: StopEvent[]): StopEvent[] {
  const sorted = [...raw].sort((a, b) => a.distM - b.distM);
  const out: StopEvent[] = [];
  for (const e of sorted) {
    const last = out.at(-1);
    if (last && e.distM - last.distM <= CLUSTER_M) {
      if (RANK[e.level] > RANK[last.level]) {
        last.level = e.level;
        last.reason = e.reason;
      }
    } else out.push({ ...e });
  }
  return out;
}

function segKey(a: Coord, b: Coord): string {
  const ka = `${a[0].toFixed(5)},${a[1].toFixed(5)}`;
  const kb = `${b[0].toFixed(5)},${b[1].toFixed(5)}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

export function segmentKeys(coords: Coord[]): Map<string, number> {
  const lengths = new Map<string, number>();
  for (let i = 1; i < coords.length; i++) lengths.set(segKey(coords[i - 1], coords[i]), distM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  return lengths;
}

export function retraceShare(coords: Coord[]): number {
  const seen = new Set<string>();
  let repeated = 0;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const key = segKey(coords[i - 1], coords[i]);
    const len = distM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    total += len;
    if (seen.has(key)) repeated += len;
    seen.add(key);
  }
  return total ? repeated / total : 0;
}

export function overlapShare(a: Coord[], b: Coord[]): number {
  const ka = segmentKeys(a);
  const kb = segmentKeys(b);
  let shared = 0;
  let total = 0;
  for (const [key, len] of ka) {
    total += len;
    if (kb.has(key)) shared += len;
  }
  return total ? shared / total : 0;
}

function cellKey(lat: number, lon: number): string {
  return `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
}

function cellsForBox(aLat: number, aLon: number, bLat: number, bLon: number): string[] {
  const keys: string[] = [];
  for (let i = Math.floor(Math.min(aLat, bLat) / CELL); i <= Math.floor(Math.max(aLat, bLat) / CELL); i++) {
    for (let j = Math.floor(Math.min(aLon, bLon) / CELL); j <= Math.floor(Math.max(aLon, bLon) / CELL); j++) keys.push(`${i}:${j}`);
  }
  return keys;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
