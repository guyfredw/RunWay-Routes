import { TileStore } from '@runway/routing/tiles';

// One tile cache for the whole server, shared by route generation and drawing.
export const tiles = new TileStore(process.env.STOP_TILES_DIR || '../data/stop-tiles/launch', 96);
export const areaAround = (lat: number, lon: number, radiusM: number) => tiles.areaAround(lat, lon, radiusM);

// The visitor's address, used only in memory for rate limits. In production a reverse proxy sets this header.
export function visitorOf(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'local';
}
