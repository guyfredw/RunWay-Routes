import { toGpx } from '@runway/routing';

// Confirms the server can load the routing package.
export function GET() {
  const sample = toGpx('Health check', [[-80.34, 25.8], [-80.34, 25.801]]);
  return Response.json({ ok: true, routing: sample.includes('<trkpt') });
}
