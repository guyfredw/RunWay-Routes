// Generates candidate running routes through BRouter, then scores them.
import { StopMap, distM, overlapShare, routeLength } from './stops.ts';
import type { Analysis, Coord } from './stops.ts';

const BROUTER = 'http://localhost:17777/brouter';
const CONCURRENCY = 2;
const BEARINGS = 12;
export const TOLERANCE = 0.05;
export const MAX_LOOP_RETRACE = 0.25;
export const MAX_BUSY_SHARE = 0.02; // Busy roads with no sidewalk tag.
export const MAX_SERVICE_SHARE = 0.05; // Access is often unclear on service roads.

export type CourseType = 'out-and-back' | 'loop';
export type Profile = 'runway-baseline' | 'runway-fewer-stops';
export type Candidate = { coords: Coord[]; analysis: Analysis; bearing: number };
export type Request = { lat: number; lon: number; distanceM: number; type: CourseType };

export async function routeThrough(points: [number, number][], profile: Profile): Promise<Coord[] | null> {
  const lonlats = points.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join('%7C');
  const res = await fetch(`${BROUTER}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`);
  if (!res.ok) return null;
  const text = await res.text();
  try {
    return JSON.parse(text).features[0].geometry.coordinates as Coord[];
  } catch {
    return null;
  }
}

export function destination(lat: number, lon: number, bearingDeg: number, meters: number): [number, number] {
  const b = (bearingDeg * Math.PI) / 180;
  const newLat = lat + (meters * Math.cos(b)) / 111320;
  const newLon = lon + (meters * Math.sin(b)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return [newLon, newLat];
}

export function cutAt(coords: Coord[], meters: number): Coord[] {
  const out: Coord[] = [coords[0]];
  let run = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = distM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    if (run + seg >= meters) {
      const f = seg ? (meters - run) / seg : 0;
      const [aLon, aLat, aEle] = coords[i - 1];
      const [bLon, bLat, bEle] = coords[i];
      const ele = aEle !== undefined && bEle !== undefined ? aEle + (bEle - aEle) * f : aEle;
      out.push([aLon + (bLon - aLon) * f, aLat + (bLat - aLat) * f, ele]);
      return out;
    }
    run += seg;
    out.push(coords[i]);
  }
  return out;
}

async function outAndBack(req: Request, bearing: number, profile: Profile): Promise<Coord[] | null> {
  const half = req.distanceM / 2;
  let radius = half * 0.9;
  for (let attempt = 0; attempt < 3; attempt++) {
    const path = await routeThrough([[req.lon, req.lat], destination(req.lat, req.lon, bearing, radius)], profile);
    if (!path) return null;
    const len = routeLength(path);
    if (len >= half) {
      const out = cutAt(path, half);
      return [...out, ...out.slice(0, -1).reverse()];
    }
    radius *= Math.min(2, (half / Math.max(len, 1)) * 1.15);
  }
  return null;
}

async function loop(req: Request, bearing: number, profile: Profile): Promise<Coord[] | null> {
  let radius = req.distanceM / (2 * Math.PI * 1.2);
  let best: Coord[] | null = null;
  let bestErr = Infinity;
  for (let attempt = 0; attempt < 4; attempt++) {
    const [cLon, cLat] = destination(req.lat, req.lon, bearing, radius);
    const via = [-90, 0, 90].map((offset) => destination(cLat, cLon, bearing + offset, radius));
    const path = await routeThrough([[req.lon, req.lat], ...via, [req.lon, req.lat]], profile);
    if (!path) return best;
    const len = routeLength(path);
    const err = Math.abs(len - req.distanceM) / req.distanceM;
    if (err < bestErr) { best = path; bestErr = err; }
    if (err <= TOLERANCE * 0.5) break;
    radius *= Math.max(0.5, Math.min(1.5, req.distanceM / Math.max(len, 1)));
  }
  return best;
}

export async function candidates(req: Request, profile: Profile, map: StopMap, seed = 0): Promise<Candidate[]> {
  const bearings = Array.from({ length: BEARINGS }, (_, i) => (i * 360) / BEARINGS + seed);
  const out: Candidate[] = [];
  let next = 0;
  const worker = async () => {
    while (next < bearings.length) {
      const bearing = bearings[next++];
      const coords = req.type === 'loop' ? await loop(req, bearing, profile) : await outAndBack(req, bearing, profile);
      if (coords && coords.length > 1) out.push({ coords, bearing, analysis: map.analyze(coords) });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

export const withinTolerance = (c: Candidate, req: Request) => Math.abs(c.analysis.distanceM - req.distanceM) / req.distanceM <= TOLERANCE;

export function usable(c: Candidate, req: Request): boolean {
  if (!withinTolerance(c, req)) return false;
  if (c.analysis.privateM > 0 || c.analysis.gates > 0) return false;
  if (c.analysis.serviceM / c.analysis.distanceM > MAX_SERVICE_SHARE) return false;
  if (c.analysis.busyNoSidewalkM / c.analysis.distanceM > MAX_BUSY_SHARE) return false;
  return req.type !== 'loop' || c.analysis.retraceShare <= MAX_LOOP_RETRACE;
}

// Stops first; repeated ground only breaks close calls.
export const score = (c: Candidate, req: Request) => c.analysis.weighted + (req.type === 'loop' ? c.analysis.retraceShare * 20 : 0);

export function pickFewestStops(list: Candidate[], req: Request): Candidate | null {
  return list.filter((c) => usable(c, req)).sort((a, b) => score(a, req) - score(b, req))[0] ?? null;
}

// Comparison route: meets the same distance rule, but ignores stops when choosing.
export function pickIgnoringStops(list: Candidate[], req: Request): Candidate | null {
  const distanceError = (c: Candidate) => Math.abs(c.analysis.distanceM - req.distanceM);
  return list.filter((c) => usable(c, req)).sort((a, b) => distanceError(a) - distanceError(b))[0] ?? null;
}

export function pickDifferent(list: Candidate[], chosen: Candidate, req: Request, maxOverlap = 0.5): Candidate | null {
  return list
    .filter((c) => c !== chosen && usable(c, req) && overlapShare(c.coords, chosen.coords) <= maxOverlap)
    .sort((a, b) => score(a, req) - score(b, req))[0] ?? null;
}
