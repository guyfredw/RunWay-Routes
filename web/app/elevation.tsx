import { distM } from '@runway/routing';
import type { Coord } from '@runway/routing';

const W = 300;
const H = 70;

// A small elevation profile along the route. Hidden when the route has no elevation data.
export default function Elevation({ coords, unit }: { coords: Coord[]; unit: 'km' | 'mi' }) {
  if (coords.length < 2 || coords.some((c) => c[2] === undefined)) return null;
  const dist: number[] = [0];
  for (let i = 1; i < coords.length; i++) dist.push(dist[i - 1] + distM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  const eles = coords.map((c) => c[2]!);
  const lo = Math.min(...eles);
  const hi = Math.max(...eles);
  const span = Math.max(hi - lo, 10); // keep flat routes looking flat
  const total = dist[dist.length - 1] || 1;
  const points = coords.map((_, i) => `${((dist[i] / total) * W).toFixed(1)},${(H - 4 - ((eles[i] - lo) / span) * (H - 12)).toFixed(1)}`);
  const feet = unit === 'mi';
  const fmt = (m: number) => (feet ? `${Math.round(m * 3.28084)} ft` : `${Math.round(m)} m`);
  return (
    <figure className="elevation">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Elevation from ${fmt(lo)} to ${fmt(hi)}`}>
        <polygon points={`0,${H} ${points.join(' ')} ${W},${H}`} className="elevation-fill" />
        <polyline points={points.join(' ')} className="elevation-line" />
      </svg>
      <figcaption>
        Elevation {fmt(lo)} to {fmt(hi)}
      </figcaption>
    </figure>
  );
}
