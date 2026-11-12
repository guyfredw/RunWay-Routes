import { createRouteHandler } from '@runway/routing/service';
import { areaAround, visitorOf } from '../../../lib/stop-tiles';

// Generates route options. POST keeps the start point out of URLs and server logs.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handle = createRouteHandler({ areaAround });

export async function POST(req: Request) {
  const outcome = await handle(await req.text(), visitorOf(req));
  return Response.json(outcome.body, { status: outcome.status, headers: { 'Cache-Control': 'no-store', ...outcome.headers } });
}
