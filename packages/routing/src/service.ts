// The route service: checks a request, generates routes near the start, and returns the chosen one.
// The website's server calls handleRouteRequest; it stores nothing and never logs start points.
import { candidates, pickFewestStops, score, usable } from './generate.ts';
import type { Candidate, CourseType, Request } from './generate.ts';
import { overlapShare } from './stops.ts';
import type { Coord, StopMap } from './stops.ts';
import { turnaroundOf } from './gpx.ts';

export const MIN_KM = 1;
export const MAX_KM = 42;
export const MAX_VARIANTS = 5;
const SEEDS = [0, 15];
const EXTRA_SEEDS = [7.5, 22.5]; // tried only when the first round finds nothing usable
const EXTRA_ROUND_BEFORE_MS = 5000; // and only if that round was quick enough to stay near 10 seconds
const MAX_BODY_BYTES = 2000;

export type RouteInput = { lat: number; lon: number; distanceKm: number; type: CourseType; variant: number };
type Parsed = { ok: true; value: RouteInput } | { ok: false; error: string };

export function parseRouteInput(body: unknown): Parsed {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Send a JSON object.' };
  const b = body as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const lat = num(b.lat);
  const lon = num(b.lon);
  const distanceKm = num(b.distanceKm);
  const variant = b.variant === undefined ? 0 : num(b.variant);
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) return { ok: false, error: 'Choose a start point on the map.' };
  if (!(distanceKm >= MIN_KM && distanceKm <= MAX_KM)) return { ok: false, error: `Distance must be between ${MIN_KM} and ${MAX_KM} km.` };
  if (b.type !== 'loop' && b.type !== 'out-and-back') return { ok: false, error: 'Choose a loop or an out-and-back route.' };
  if (!Number.isInteger(variant) || variant < 0 || variant >= 1000) return { ok: false, error: 'Variant must be a whole number from 0.' };
  return { ok: true, value: { lat, lon, distanceKm, type: b.type, variant } };
}

// How far from the start a route can reach, so enough stop data is loaded.
export const searchRadiusM = (distanceKm: number) => Math.round(distanceKm * 500 + 1500);

// The best usable routes, each overlapping earlier picks by no more than half.
export function distinctRoutes(list: Candidate[], req: Request, max = MAX_VARIANTS, maxOverlap = 0.5): Candidate[] {
  const chosen: Candidate[] = [];
  const first = pickFewestStops(list, req);
  if (!first) return chosen;
  chosen.push(first);
  for (const c of list.filter((c) => usable(c, req)).sort((a, b) => score(a, req) - score(b, req))) {
    if (chosen.length >= max) break;
    if (chosen.every((p) => p !== c && overlapShare(c.coords, p.coords) <= maxOverlap)) chosen.push(c);
  }
  return chosen;
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

export type RouteResponse = {
  type: CourseType;
  variant: number;
  options: number;
  distanceM: number;
  gainM: number;
  coords: Coord[];
  stops: { lat: number; lon: number; likely: boolean; signal: boolean; wait: string; road?: string; distM: number }[];
  summary: { likelyStops: number; otherCrossings: number; signals: number; noSidewalkM: number };
  noSidewalk: [number, number][][];
  turnaround: { lat: number; lon: number; distM: number } | null;
  warnings: string[];
};

export function toResponse(c: Candidate, req: Request, variant: number, options: number, missingStartTile: boolean): RouteResponse {
  const a = c.analysis;
  const noSidewalkM = Math.round(a.quietNoSidewalkM + a.busyNoSidewalkM);
  const warnings: string[] = [];
  if (missingStartTile) warnings.push('This start point is outside the area with stop data, so stops and sidewalks are not counted.');
  else if (a.distanceM >= 3000 && a.total === 0) warnings.push('No crossings were found on this route. Map data here may be missing crossings, so expect more stops than shown.');
  if (noSidewalkM >= 50) warnings.push(`About ${noSidewalkM} m of this route has no mapped sidewalk.`);
  const turn = req.type === 'out-and-back' ? turnaroundOf(c.coords) : null;
  return {
    type: req.type,
    variant,
    options,
    distanceM: Math.round(a.distanceM),
    gainM: Math.round(a.gainM),
    coords: c.coords.map(([lon, lat, ele]) => (ele === undefined ? [round(lon, 6), round(lat, 6)] : [round(lon, 6), round(lat, 6), round(ele, 1)])),
    stops: a.events.map((e) => ({ lat: round(e.lat, 6), lon: round(e.lon, 6), likely: e.likely, signal: e.signal, wait: e.wait, road: e.road, distM: Math.round(e.distM) })),
    summary: { likelyStops: a.likelyStops, otherCrossings: a.otherCrossings, signals: a.signals, noSidewalkM },
    noSidewalk: a.noSidewalk.map((line) => line.map(([x, y]) => [round(x, 6), round(y, 6)] as [number, number])),
    turnaround: turn && { lat: turn.lat, lon: turn.lon, distM: Math.round(c.analysis.distanceM / 2) },
    warnings,
  };
}

export type StopArea = { map: StopMap; startCovered: boolean };
export type Outcome = { status: number; body: RouteResponse | { error: string }; headers?: Record<string, string> };

export async function planRoute(input: RouteInput, areaAround: (lat: number, lon: number, radiusM: number) => StopArea): Promise<Outcome> {
  const req: Request = { lat: input.lat, lon: input.lon, distanceM: input.distanceKm * 1000, type: input.type };
  const { map, startCovered } = areaAround(input.lat, input.lon, searchRadiusM(input.distanceKm));
  const all: Candidate[] = [];
  const started = Date.now();
  for (const seed of SEEDS) all.push(...(await candidates(req, 'runway-fewer-stops', map, seed)));
  if (!all.some((c) => usable(c, req)) && Date.now() - started < EXTRA_ROUND_BEFORE_MS) {
    for (const seed of EXTRA_SEEDS) all.push(...(await candidates(req, 'runway-fewer-stops', map, seed)));
  }
  if (all.length === 0) return { status: 422, body: { error: 'No routes could be made from this start point. It may be outside the area the site covers.' } };
  const routes = distinctRoutes(all, req);
  if (routes.length === 0) return { status: 422, body: { error: 'No route near this start point stays within 5% of the distance while avoiding busy roads without sidewalks and private roads. Try a start point on a quieter street, or another distance.' } };
  const variant = input.variant % routes.length;
  return { status: 200, body: toResponse(routes[variant], req, variant, routes.length, !startCovered) };
}

// Allows each key a set number of actions per time window.
export class RateLimiter {
  private hits = new Map<string, number[]>();
  readonly limit: number;
  readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterS: number } {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterS: Math.ceil((recent[0] + this.windowMs - now) / 1000) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10000) this.prune(now);
    return { ok: true };
  }

  private prune(now: number) {
    for (const [k, times] of this.hits) if (!times.some((t) => t > now - this.windowMs)) this.hits.delete(k);
  }
}

export type HandlerOptions = {
  areaAround: (lat: number, lon: number, radiusM: number) => StopArea;
  perMinute?: number;
  perHour?: number;
  maxBusy?: number; // routes generated at the same time across all visitors
};

// Handles one POST body from one visitor. Errors never echo the request back.
export function createRouteHandler(opts: HandlerOptions) {
  const minute = new RateLimiter(opts.perMinute ?? 6, 60_000);
  const hour = new RateLimiter(opts.perHour ?? 60, 3_600_000);
  const maxBusy = opts.maxBusy ?? 2;
  let busy = 0;
  return async (bodyText: string, visitor: string): Promise<Outcome> => {
    if (Buffer.byteLength(bodyText) > MAX_BODY_BYTES) return { status: 413, body: { error: 'Request is too large.' } };
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return { status: 400, body: { error: 'Send a JSON object.' } };
    }
    const parsed = parseRouteInput(body);
    if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
    if (busy >= maxBusy) return { status: 503, body: { error: 'The route service is busy. Try again in a few seconds.' }, headers: { 'Retry-After': '5' } };
    for (const limiter of [minute, hour]) {
      const r = limiter.take(visitor);
      if (!r.ok) return { status: 429, body: { error: `Too many routes requested. Try again in ${r.retryAfterS} s.` }, headers: { 'Retry-After': String(r.retryAfterS) } };
    }
    busy++;
    try {
      return await planRoute(parsed.value, opts.areaAround);
    } catch {
      return { status: 502, body: { error: 'The route service could not reach the routing engine. Try again shortly.' } };
    } finally {
      busy--;
    }
  };
}
