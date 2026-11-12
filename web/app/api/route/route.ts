import { createRouteHandler } from '@runway/routing/service';
import { TileStore } from '@runway/routing/tiles';

// Generates one route. POST keeps the start point out of URLs and server logs.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const tiles = new TileStore(process.env.STOP_TILES_DIR || '../data/stop-tiles/launch', 96);
const handle = createRouteHandler({ areaAround: (lat, lon, radiusM) => tiles.areaAround(lat, lon, radiusM) });

// The visitor's address, used only in memory for rate limits. In production a reverse proxy sets this header.
function visitorOf(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'local';
}

export async function POST(req: Request) {
  const outcome = await handle(await req.text(), visitorOf(req));
  return Response.json(outcome.body, { status: outcome.status, headers: { 'Cache-Control': 'no-store', ...outcome.headers } });
}
