// Writes routes as GPX 1.1 files for COROS and Garmin watches.
import { routeLength } from './stops.ts';
import type { Coord } from './stops.ts';

export type Waypoint = { lat: number; lon: number; name: string; desc?: string; sym?: string };

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// An out-and-back route turns around at its middle point.
export function turnaroundOf(coords: Coord[]): Waypoint {
  const mid = coords[Math.floor((coords.length - 1) / 2)];
  const km = routeLength(coords.slice(0, Math.floor((coords.length - 1) / 2) + 1)) / 1000;
  return { lat: mid[1], lon: mid[0], name: 'Turnaround', desc: `Turn around here (${km.toFixed(2)} km)`, sym: 'Flag' };
}

export function toGpx(name: string, coords: Coord[], waypoints: Waypoint[] = []): string {
  const wpts = waypoints.map((w) =>
    `<wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}"><name>${xml(w.name)}</name>${w.desc ? `<desc>${xml(w.desc)}</desc>` : ''}${w.sym ? `<sym>${xml(w.sym)}</sym>` : ''}</wpt>`).join('\n');
  const points = coords.map(([lon, lat, ele]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${ele !== undefined ? `<ele>${ele.toFixed(1)}</ele>` : ''}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RunWay Routes" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${xml(name)}</name></metadata>
${wpts ? `${wpts}\n` : ''}<trk><name>${xml(name)}</name><trkseg>
${points}
</trkseg></trk>
</gpx>
`;
}
