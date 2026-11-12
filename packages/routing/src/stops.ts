// Estimates likely running stops along a route using OpenStreetMap data.
// Field tests showed runners usually cross unsignalled crossings without stopping,
// so only traffic signals and very wide roads count as likely stops.
// Each stop gets a wait estimate from the width of the road crossed (lanes),
// plus extra weight for traffic signals. Also measures road sections with no
// evidence of a sidewalk.

export type Coord = [lon: number, lat: number, ele?: number];
export type Wait = 'short' | 'medium' | 'long';
export type StopEvent = {
  distM: number; lat: number; lon: number; lanes: number; signal: boolean; wait: Wait; weight: number; reason: string;
  likely: boolean; // a likely stop, not just a crossing
  road?: string; // name of the road crossed
  carriageways?: Record<string, number>; // one-way halves of divided roads crossed here: 'name|direction' -> lanes
};

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
  long: number;
  medium: number;
  short: number;
  total: number;
  likelyStops: number;
  otherCrossings: number;
  weighted: number;
  privateM: number;
  serviceM: number;
  serviceNearEndsM: number; // service road within ENDS_M of the start or finish, such as leaving a parking lot
  busyNoSidewalkM: number;
  quietNoSidewalkM: number;
  sidewalkPenalty: number;
  noSidewalk: [number, number][][];
  gates: number;
  retraceShare: number;
  matchedShare: number;
};

export const WAIT_WEIGHTS: Record<Wait, number> = { short: 1, medium: 3, long: 5 };
export const SIGNAL_WEIGHT = 3;
// Unsignalled crossings narrower than 5 lanes rarely meant a stop in field tests.
export const CROSSING_WEIGHTS: Record<Wait, number> = { short: 0.5, medium: 1, long: 5 };
export const LIKELY_STOP_LANES = 5;
export const ENDS_M = 400; // distance from the start and finish where service roads are expected
const DEFAULT_LANES: Record<string, number> = { trunk: 4, primary: 4, secondary: 4, tertiary: 2, residential: 2, unclassified: 2, living_street: 1, service: 1 };
const CLUSTER_M = 35;
const INTERSECTION_M = 60; // Longest stretch of nearby map points treated as one intersection.
const DIVIDED_ROAD_M = 80; // Both halves of a divided road with the same name count as one crossing.
const SIGNAL_NEAR_M = 20;
const SIDEWALK_NEAR_M = 20;
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

export function waitFor(lanes: number): Wait {
  return lanes >= 5 ? 'long' : lanes >= 3 ? 'medium' : 'short';
}

export const isLikelyStop = (lanes: number, signal: boolean) => signal || lanes >= LIKELY_STOP_LANES;

export const weightOf = (lanes: number, signal: boolean) =>
  signal ? WAIT_WEIGHTS[waitFor(lanes)] + SIGNAL_WEIGHT : CROSSING_WEIGHTS[waitFor(lanes)];

function roadClass(tags: Record<string, string> | undefined): 'major' | 'minor' | null {
  const h = tags?.highway ?? '';
  if (/^(primary|secondary|tertiary|trunk)(_link)?$/.test(h)) return 'major';
  if (/^(residential|unclassified|living_street)$/.test(h)) return 'minor';
  return null;
}

export function lanesOf(tags: Record<string, string> | undefined): number {
  const n = parseFloat((tags?.lanes ?? '').split(';')[0]);
  if (n > 0) return Math.round(n);
  return DEFAULT_LANES[(tags?.highway ?? '').replace(/_link$/, '')] ?? 1;
}

const isSignalNode = (t?: Record<string, string>) => t?.highway === 'traffic_signals' || t?.crossing === 'traffic_signals' || t?.crossing === 'pedestrian_signals';
const isSeparatedLevel = (t?: Record<string, string>) => !!t && ((t.bridge && t.bridge !== 'no') || (t.tunnel && t.tunnel !== 'no'));
const isPrivate = (t?: Record<string, string>) => !!t && (t.access === 'private' || t.access === 'no' || t.foot === 'no' || t.foot === 'private');
const isWalkPath = (t?: Record<string, string>) => /^(footway|path|cycleway|pedestrian)$/.test(t?.highway ?? '') && t?.footway !== 'crossing';

function segmentsCross(aLat: number, aLon: number, bLat: number, bLon: number, cLat: number, cLon: number, dLat: number, dLon: number): boolean {
  const o = (pLat: number, pLon: number, qLat: number, qLon: number, rLat: number, rLon: number) => (qLon - pLon) * (rLat - pLat) - (qLat - pLat) * (rLon - pLon);
  const d1 = o(cLat, cLon, dLat, dLon, aLat, aLon);
  const d2 = o(cLat, cLon, dLat, dLon, bLat, bLon);
  const d3 = o(aLat, aLon, bLat, bLon, cLat, cLon);
  const d4 = o(aLat, aLon, bLat, bLon, dLat, dLon);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

// Compass quarter a one-way road runs in: 0 north, 1 east, 2 south, 3 west.
function directionOf(w: OsmElement): number {
  const g = (w.geometry ?? []).filter((p): p is { lat: number; lon: number } => !!p);
  if (g.length < 2) return 0;
  const a = g[0];
  const b = g[g.length - 1];
  const deg = (Math.atan2((b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat) * 180) / Math.PI;
  return Math.round(((deg + 360) % 360) / 90) % 4;
}

function pointToSegmentM(lat: number, lon: number, s: Seg): number {
  const k = Math.cos((lat * Math.PI) / 180);
  const px = (lon - s.aLon) * k * M_PER_DEG;
  const py = (lat - s.aLat) * M_PER_DEG;
  const dx = (s.bLon - s.aLon) * k * M_PER_DEG;
  const dy = (s.bLat - s.aLat) * M_PER_DEG;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
  return Math.hypot(px - t * dx, py - t * dy);
}

type Node = { lat: number; lon: number; tags?: Record<string, string> };
type Seg = { way: number; aLat: number; aLon: number; bLat: number; bLon: number };

export class StopMap {
  ways: OsmElement[] = [];
  nodes = new Map<number, Node>();
  nodeWays = new Map<number, number[]>();
  nodeGrid = new Map<string, number[]>();
  roadSegGrid = new Map<string, Seg[]>();
  pathSegGrid = new Map<string, Seg[]>();
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
      const walk = isWalkPath(e.tags);
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
        if (!next) return;
        const seg = { way: wayIndex, aLat: g.lat, aLon: g.lon, bLat: next.lat, bLon: next.lon };
        if (cls && !separated) for (const key of cellsForBox(g.lat, g.lon, next.lat, next.lon)) push(this.roadSegGrid, key, seg);
        if (walk) for (const key of cellsForBox(g.lat, g.lon, next.lat, next.lon)) push(this.pathSegGrid, key, seg);
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

  // A sidewalk is likely if the road is tagged with one, or a mapped footpath runs alongside.
  hasSidewalkEvidence(way: number, lat: number, lon: number): boolean {
    const s = this.ways[way].tags?.sidewalk ?? '';
    if (/^(both|left|right|yes|separate)$/.test(s)) return true;
    if (/^(no|none)$/.test(s)) return false;
    const r = Math.floor(lat / CELL);
    const c = Math.floor(lon / CELL);
    for (let i = r - 1; i <= r + 1; i++) for (let j = c - 1; j <= c + 1; j++) {
      for (const seg of this.pathSegGrid.get(`${i}:${j}`) ?? []) if (pointToSegmentM(lat, lon, seg) <= SIDEWALK_NEAR_M) return true;
    }
    return false;
  }

  maxLanes(ways: Iterable<number>): number {
    let best = 0;
    for (const w of ways) if (roadClass(this.ways[w].tags)) best = Math.max(best, lanesOf(this.ways[w].tags));
    return best;
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
    const add = (i: number, lanes: number, signalled: boolean, reason: string, roadWays: Iterable<number> = []) => {
      const lat = coords[i][1];
      const lon = coords[i][0];
      const signal = signalled || this.nearSignal(lat, lon);
      const l = Math.max(1, lanes);
      const roads = [...roadWays].filter((w) => roadClass(this.ways[w].tags)).sort((a, b) => lanesOf(this.ways[b].tags) - lanesOf(this.ways[a].tags));
      const widest = roads[0] === undefined ? undefined : this.ways[roads[0]];
      const carriageways: Record<string, number> = {};
      for (const w of roads) {
        const t = this.ways[w].tags;
        if (t?.oneway !== 'yes' || !t.name) continue;
        // Key by road name and direction, so map pieces of the same half don't add up.
        const key = `${t.name}|${directionOf(this.ways[w])}`;
        carriageways[key] = Math.max(carriageways[key] ?? 0, lanesOf(t));
      }
      raw.push({ distM: cum[i], lat, lon, lanes: l, signal, wait: waitFor(l), weight: weightOf(l, signal), likely: isLikelyStop(l, signal), reason, road: widest?.tags?.name, carriageways });
    };

    let gates = 0;
    let privateM = 0;
    let serviceM = 0;
    let serviceNearEndsM = 0;
    const total = cum[cum.length - 1] ?? 0;
    let busyNoSidewalkM = 0;
    let quietNoSidewalkM = 0;
    let sidewalkPenalty = 0;
    const noSidewalk: [number, number][][] = [];
    let lastNoSidewalkEnd = -1;
    const traversedAt: Set<number>[] = [];

    for (let k = 0; k < matched.length; k++) {
      const { i, id } = matched[k];
      const before = k > 0 ? shared(matched[k - 1].id, id) : [];
      const after = k + 1 < matched.length ? shared(id, matched[k + 1].id) : [];
      const traversed = new Set([...before, ...after]);
      traversedAt[k] = traversed;
      const tags = this.nodes.get(id)?.tags;
      const onRoad = [...traversed].some((w) => roadClass(this.ways[w].tags));
      const crossedHere = (this.nodeWays.get(id) ?? []).filter((w) => !traversed.has(w));

      if (tags?.barrier === 'gate') gates++;
      if (isSignalNode(tags)) {
        add(i, this.maxLanes(crossedHere) || this.maxLanes(this.nodeWays.get(id) ?? []) || 2, true, 'traffic signal', crossedHere.length ? crossedHere : this.nodeWays.get(id) ?? []);
      } else if (tags?.highway === 'crossing' && !onRoad) {
        add(i, this.maxLanes(crossedHere) || 2, false, 'crossing', crossedHere);
      }

      if (traversed.size > 0) {
        for (const w of crossedHere) {
          if (roadClass(this.ways[w].tags)) add(i, lanesOf(this.ways[w].tags), false, `${this.ways[w].tags?.highway} road`, [w]);
        }
      }

      if (k + 1 < matched.length) {
        const j = matched[k + 1].i;
        const segLen = cum[j] - cum[i];
        const crossing = after.map((w) => this.ways[w]).find((w) => w.tags?.footway === 'crossing');
        if (crossing) {
          const t = crossing.tags!;
          const signalled = t.crossing === 'traffic_signals' || t['crossing:signals'] === 'yes';
          const roadsCrossed = new Set((crossing.nodes ?? []).flatMap((n) => this.nodeWays.get(n) ?? []));
          add(i, this.maxLanes(roadsCrossed) || 1, signalled, 'crosswalk', roadsCrossed);
        }
        if (after.length > 0 && after.every((w) => isPrivate(this.ways[w].tags))) privateM += segLen;
        if (after.length > 0 && after.every((w) => this.ways[w].tags?.highway === 'service')) {
          serviceM += segLen;
          if (cum[i] < ENDS_M || cum[j] > total - ENDS_M) serviceNearEndsM += segLen;
        }

        // Running along a road: is there any sign of a sidewalk here?
        const road = after.find((w) => roadClass(this.ways[w].tags));
        if (road !== undefined && !after.some((w) => isWalkPath(this.ways[w].tags))) {
          const midLat = (coords[i][1] + coords[j][1]) / 2;
          const midLon = (coords[i][0] + coords[j][0]) / 2;
          const evidence = [[coords[i][1], coords[i][0]], [midLat, midLon], [coords[j][1], coords[j][0]]]
            .filter(([la, lo]) => this.hasSidewalkEvidence(road, la, lo)).length >= 2;
          if (!evidence) {
            const t = this.ways[road].tags;
            const lanes = lanesOf(t);
            if (roadClass(t) === 'major') {
              busyNoSidewalkM += segLen;
              sidewalkPenalty += segLen * 3;
            } else {
              quietNoSidewalkM += segLen;
              sidewalkPenalty += segLen * (lanes >= 5 ? 3 : lanes >= 3 ? 2 : 1);
            }
            const piece = coords.slice(i, j + 1).map((c) => [c[0], c[1]] as [number, number]);
            if (lastNoSidewalkEnd === i && noSidewalk.length) noSidewalk.at(-1)!.push(...piece.slice(1));
            else noSidewalk.push(piece);
            lastNoSidewalkEnd = j;
          }
        }
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
      const seen = new Set<Seg>();
      for (const key of cellsForBox(a[1], a[0], b[1], b[0])) {
        for (const s of this.roadSegGrid.get(key) ?? []) {
          if (seen.has(s) || local.has(s.way)) continue;
          seen.add(s);
          if (segmentsCross(a[1], a[0], b[1], b[0], s.aLat, s.aLon, s.bLat, s.bLon)) {
            add(i, lanesOf(this.ways[s.way].tags), false, `${this.ways[s.way].tags?.highway} road, no shared node`, [s.way]);
          }
        }
      }
    }

    const events = cluster(raw);
    return {
      distanceM: cum.at(-1) ?? 0,
      gainM: elevationGain(coords),
      events,
      signals: events.filter((e) => e.signal).length,
      long: events.filter((e) => e.wait === 'long').length,
      medium: events.filter((e) => e.wait === 'medium').length,
      short: events.filter((e) => e.wait === 'short').length,
      total: events.length,
      likelyStops: events.filter((e) => e.likely).length,
      otherCrossings: events.filter((e) => !e.likely).length,
      weighted: events.reduce((n, e) => n + e.weight, 0),
      privateM,
      serviceM,
      serviceNearEndsM,
      busyNoSidewalkM,
      quietNoSidewalkM,
      sidewalkPenalty: sidewalkPenalty / 100,
      noSidewalk,
      gates,
      retraceShare: retraceShare(coords),
      matchedShare: coords.length ? matched.length / coords.length : 0,
    };
  }
}

// Map nodes from one intersection become one stop: the widest road and any signal win.
// Both halves of a divided road become one crossing, as wide as the two halves together.
export function cluster(raw: StopEvent[]): StopEvent[] {
  const sorted = [...raw].sort((a, b) => a.distM - b.distM);
  const out: StopEvent[] = [];
  const startOf = new Map<StopEvent, number>();
  let latest = -Infinity; // distance of the most recent point added to the current stop
  for (const e of sorted) {
    const last = out.at(-1);
    const start = last ? startOf.get(last) ?? last.distM : 0;
    const nearby = !!last && e.distM - latest <= CLUSTER_M && e.distM - start <= INTERSECTION_M;
    const lastNames = new Set(Object.keys(last?.carriageways ?? {}).map((k) => k.split('|')[0]));
    const sameDividedRoad = !!last && Object.keys(e.carriageways ?? {}).some((k) => lastNames.has(k.split('|')[0]))
      && e.distM - start <= DIVIDED_ROAD_M;
    if (last && (nearby || sameDividedRoad)) {
      if (e.weight > last.weight) last.reason = e.reason;
      for (const [key, lanes] of Object.entries(e.carriageways ?? {})) last.carriageways![key] = Math.max(last.carriageways![key] ?? 0, lanes);
      const divided = dividedWidth(last.carriageways!);
      last.lanes = Math.max(last.lanes, e.lanes, divided);
      last.signal = last.signal || e.signal;
      last.wait = waitFor(last.lanes);
      last.weight = weightOf(last.lanes, last.signal);
      last.likely = isLikelyStop(last.lanes, last.signal);
      if (!last.road) last.road = e.road;
    } else {
      const copy = { ...e, carriageways: { ...e.carriageways } };
      startOf.set(copy, e.distM);
      out.push(copy);
    }
    latest = e.distM;
  }
  return out;
}

// Width of the widest divided road crossed: both halves together, when halves in opposite directions are present.
function dividedWidth(carriageways: Record<string, number>): number {
  const byName = new Map<string, Map<number, number>>();
  for (const [key, lanes] of Object.entries(carriageways)) {
    const [name, dir] = key.split('|');
    if (!byName.has(name)) byName.set(name, new Map());
    byName.get(name)!.set(Number(dir), lanes);
  }
  let best = 0;
  for (const dirs of byName.values()) {
    if (![...dirs.keys()].some((d) => dirs.has((d + 2) % 4))) continue;
    best = Math.max(best, [...dirs.values()].reduce((a, b) => a + b, 0));
  }
  return best;
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
