// Generates candidate running routes through BRouter, then scores them.
import { StopMap, distM, overlapShare, routeLength } from './stops.ts';
import type { Analysis, Coord, Trail } from './stops.ts';

// Where BRouter runs. The website sets BROUTER_URL; the prototype uses the local default.
const BROUTER = (typeof process !== 'undefined' && process.env.BROUTER_URL) || 'http://localhost:17777/brouter';
const CONCURRENCY = 2;
const BEARINGS = 12;
export const TOLERANCE = 0.05;
export const MAX_LOOP_RETRACE = 0.25;
export const MAX_BUSY_SHARE = 0.02; // Tertiary or busier roads with no sign of a sidewalk.
export const MAX_SERVICE_SHARE = 0.05; // Access is often unclear on service roads.

export type CourseType = 'out-and-back' | 'loop';
export type Profile = 'runway-baseline' | 'runway-fewer-stops';
export type Candidate = { coords: Coord[]; analysis: Analysis; bearing: number; trail?: string };
export type Request = { lat: number; lon: number; distanceM: number; type: CourseType };

export async function routeThrough(points: [number, number][], profile: Profile): Promise<Coord[] | null> {
  const lonlats = points.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join('%7C');
  const res = await fetch(`${BROUTER}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`, { signal: AbortSignal.timeout(20_000) });
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

// Trail-seeking candidates. Compass bearings rarely line up with a trail, so these aim at trails
// near the start on purpose: run to the nearest point of a trail, then follow it in each direction.
export const MAX_TRAILS = 2;
export const trailSearchM = (distanceM: number) => Math.min(3000, distanceM / 3);
const MIN_TRAIL_RUN_M = 300;

type LatLon = { lat: number; lon: number };
const bearingOf = (a: LatLon, b: LatLon) =>
  (Math.atan2((b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat) * 180) / Math.PI;
const dist = (a: LatLon, b: LatLon) => distM(a.lat, a.lon, b.lat, b.lon);
const nearest = (points: LatLon[], to: LatLon) => points.reduce((best, p) => (dist(p, to) < dist(best, to) ? p : best));
const farthest = (points: LatLon[], from: LatLon) => points.reduce((best, p) => (dist(p, from) > dist(best, from) ? p : best));

// Where the route joins the trail, and the trail's ends in each direction from there.
export function trailEnds(t: Trail, start: LatLon): { entry: LatLon; ends: LatLon[] } {
  const entry = nearest(t.points, start);
  const a = farthest(t.points, entry);
  const b = farthest(t.points, a);
  const ends = [a, b].filter((x, i, all) => dist(entry, x) >= MIN_TRAIL_RUN_M && (i === 0 || dist(x, all[0]) >= MIN_TRAIL_RUN_M));
  return { entry, ends };
}

// A point `along` metres from the entry toward an end: on the trail while it lasts, then straight on past its end.
export function alongTrail(t: Trail, entry: LatLon, end: LatLon, along: number): [number, number] {
  const toEnd = dist(entry, end);
  if (along >= toEnd) return destination(entry.lat, entry.lon, bearingOf(entry, end), along);
  const ahead = t.points.filter((p) => dist(p, end) < toEnd);
  const p = ahead.reduce((best, q) => (Math.abs(dist(entry, q) - along) < Math.abs(dist(entry, best) - along) ? q : best), ahead[0] ?? end);
  return [p.lon, p.lat];
}

async function trailOutAndBack(req: Request, t: Trail, entry: LatLon, end: LatLon, profile: Profile): Promise<Coord[] | null> {
  const half = req.distanceM / 2;
  let along = Math.max(MIN_TRAIL_RUN_M, (half - dist(req, entry) * 1.2) * 0.9);
  for (let attempt = 0; attempt < 3; attempt++) {
    const path = await routeThrough([[req.lon, req.lat], [entry.lon, entry.lat], alongTrail(t, entry, end, along)], profile);
    if (!path) return null;
    const len = routeLength(path);
    if (len >= half) {
      const out = cutAt(path, half);
      return [...out, ...out.slice(0, -1).reverse()];
    }
    along *= Math.min(2, (half / Math.max(len, 1)) * 1.15);
  }
  return null;
}

// Out along the trail, then back toward the start on the start's side of it, so the return isn't the same trail.
async function trailLoop(req: Request, t: Trail, entry: LatLon, end: LatLon, profile: Profile, farSide: boolean): Promise<Coord[] | null> {
  const heading = bearingOf(entry, end);
  const startSide = ((bearingOf(entry, req) - heading + 540) % 360) - 180 < 0 ? -90 : 90;
  const side = farSide ? -startSide : startSide;
  let along = Math.max(MIN_TRAIL_RUN_M, (req.distanceM - 2.6 * dist(req, entry)) / 2.4);
  let best: Coord[] | null = null;
  let bestErr = Infinity;
  for (let attempt = 0; attempt < 4; attempt++) {
    const [fLon, fLat] = alongTrail(t, entry, end, along);
    const back = destination(fLat, fLon, heading + side, Math.max(400, along * 0.4));
    const path = await routeThrough([[req.lon, req.lat], [entry.lon, entry.lat], [fLon, fLat], back, [req.lon, req.lat]], profile);
    if (!path) return best;
    const len = routeLength(path);
    const err = Math.abs(len - req.distanceM) / req.distanceM;
    if (err < bestErr) { best = path; bestErr = err; }
    if (err <= TOLERANCE * 0.5) break;
    along *= Math.max(0.5, Math.min(1.5, req.distanceM / Math.max(len, 1)));
  }
  return best;
}

export async function trailCandidates(req: Request, profile: Profile, map: StopMap): Promise<Candidate[]> {
  const jobs: { t: Trail; entry: LatLon; end: LatLon; farSide: boolean }[] = [];
  for (const t of map.trails(req.lat, req.lon, trailSearchM(req.distanceM)).slice(0, MAX_TRAILS)) {
    const { entry, ends } = trailEnds(t, req);
    for (const end of ends) {
      jobs.push({ t, entry, end, farSide: false });
      if (req.type === 'loop') jobs.push({ t, entry, end, farSide: true }); // come back on the other side of the trail
    }
  }
  const out: Candidate[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { t, entry, end, farSide } = jobs[next++];
      const coords = req.type === 'loop' ? await trailLoop(req, t, entry, end, profile, farSide) : await trailOutAndBack(req, t, entry, end, profile);
      if (coords && coords.length > 1) out.push({ coords, bearing: bearingOf(entry, end), analysis: map.analyze(coords), trail: t.name || undefined });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

export const withinTolerance = (c: Candidate, req: Request) => Math.abs(c.analysis.distanceM - req.distanceM) / req.distanceM <= TOLERANCE;

export function usable(c: Candidate, req: Request): boolean {
  if (!withinTolerance(c, req)) return false;
  if (c.analysis.privateM > 0 || c.analysis.gates > 0) return false;
  // Leaving a parking lot near the start or finish, or a service road onto a trail, doesn't count against the route.
  if (c.analysis.serviceUncertainM / c.analysis.distanceM > MAX_SERVICE_SHARE) return false;
  if (c.analysis.busyNoSidewalkM / c.analysis.distanceM > MAX_BUSY_SHARE) return false;
  return req.type !== 'loop' || c.analysis.retraceShare <= MAX_LOOP_RETRACE;
}

// Stops and road sections with no sign of a sidewalk; repeated ground only breaks close calls.
// Credit for each metre on trails, small enough that a route with clearly fewer stops still wins.
export const TRAIL_BONUS_PER_M = 0.01; // 1 km of trail is worth about 1 to 2 likely stops
export const score = (c: Candidate, req: Request) =>
  c.analysis.weighted + c.analysis.sidewalkPenalty + (req.type === 'loop' ? c.analysis.retraceShare * 20 : 0) - TRAIL_BONUS_PER_M * (c.analysis.trailM ?? 0);

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
