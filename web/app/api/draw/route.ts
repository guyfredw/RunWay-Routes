import { createDrawHandler } from '@runway/routing/service';
import { areaAround, visitorOf } from '../../../lib/stop-tiles';

// Joins a runner's clicked points along roads and paths, and estimates its stops.
// POST keeps the points out of URLs and server logs.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handle = createDrawHandler({ areaAround });

export async function POST(req: Request) {
  const outcome = await handle(await req.text(), visitorOf(req));
  return Response.json(outcome.body, { status: outcome.status, headers: { 'Cache-Control': 'no-store', ...outcome.headers } });
}
