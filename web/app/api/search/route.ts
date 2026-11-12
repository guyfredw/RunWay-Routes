import { RateLimiter } from '@runway/routing/service';

// Forwards address searches to Nominatim, following its usage policy: identify the app,
// send at most about one request per second in total, and cache repeat searches.
// POST keeps the address out of URLs and server logs. Searches are kept in memory only.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOMINATIM = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'RunWayRoutes/0.1 (https://github.com/guyfredw/RunWay-Routes)';
const CACHE_MS = 60 * 60 * 1000;
const MAX_CACHE = 500;
const MAX_QUEUE = 10;
const GAP_MS = 1100;

export type Place = { name: string; lat: number; lon: number; bbox: [south: number, north: number, west: number, east: number] };

const cache = new Map<string, { at: number; places: Place[] }>();
const perMinute = new RateLimiter(10, 60_000);
let lastSent = 0;
let queued = 0;
let chain: Promise<void> = Promise.resolve();

// Waits for this request's turn, so requests to Nominatim are spaced out.
function turn(): Promise<void> {
  const mine = chain.then(async () => {
    const wait = lastSent + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSent = Date.now();
  });
  chain = mine.catch(() => {});
  return mine;
}

function visitorOf(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'local';
}

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

export async function POST(req: Request) {
  const text = await req.text();
  if (text.length > 1000) return reply({ error: 'Request is too large.' }, 413);
  let q = '';
  try {
    const body = JSON.parse(text) as { q?: unknown };
    q = typeof body.q === 'string' ? body.q.trim().replace(/\s+/g, ' ') : '';
  } catch {
    return reply({ error: 'Send a JSON object.' }, 400);
  }
  if (q.length < 2 || q.length > 200) return reply({ error: 'Enter an address, place or ZIP code.' }, 400);

  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return reply({ places: hit.places });

  const limit = perMinute.take(visitorOf(req));
  if (!limit.ok) return reply({ error: `Too many searches. Try again in ${limit.retryAfterS} s.` }, 429, { 'Retry-After': String(limit.retryAfterS) });
  if (queued >= MAX_QUEUE) return reply({ error: 'Search is busy. Try again in a few seconds.' }, 503, { 'Retry-After': '5' });

  queued++;
  try {
    await turn();
    const url = `${NOMINATIM}?${new URLSearchParams({ q, format: 'jsonv2', limit: '5' })}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return reply({ error: 'Search is unavailable right now. Try again shortly.' }, 502);
    const raw = (await res.json()) as { display_name: string; lat: string; lon: string; boundingbox: string[] }[];
    const places: Place[] = raw.map((p) => ({
      name: p.display_name,
      lat: Number(p.lat),
      lon: Number(p.lon),
      bbox: p.boundingbox.map(Number) as Place['bbox'],
    }));
    cache.set(key, { at: Date.now(), places });
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
    return reply({ places });
  } catch {
    return reply({ error: 'Search is unavailable right now. Try again shortly.' }, 502);
  } finally {
    queued--;
  }
}
