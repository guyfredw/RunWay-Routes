import type { ReactNode } from 'react';
import { toGpx, turnaroundOf } from '@runway/routing';
import type { RouteOption } from '@runway/routing/service';
import Elevation from './elevation';

export type Unit = 'km' | 'mi';
export const KM_PER_MI = 1.609344;
export const fmtDist = (m: number, unit: Unit) => (unit === 'km' ? `${(m / 1000).toFixed(2)} km` : `${(m / 1000 / KM_PER_MI).toFixed(2)} mi`);
const fmtClimb = (m: number, unit: Unit) => (unit === 'km' ? `${m} m` : `${Math.round(m * 3.28084)} ft`);

// Summary, warnings, elevation, actions and map key for one route, generated or drawn.
export default function RouteDetails({ route, unit, actions, note }: { route: RouteOption; unit: Unit; actions: ReactNode; note?: ReactNode }) {
  return (
    <>
      <dl className="summary">
        <div><dt>Distance</dt><dd data-testid="distance">{fmtDist(route.distanceM, unit)}</dd></div>
        <div><dt>Likely stops</dt><dd data-testid="likely-stops">{route.summary.likelyStops}</dd></div>
        <div><dt>Other crossings</dt><dd>{route.summary.otherCrossings}</dd></div>
        <div><dt>Climb</dt><dd>{fmtClimb(route.gainM, unit)}</dd></div>
      </dl>
      {route.warnings.length > 0 && (
        <ul className="warnings">
          {route.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      <Elevation coords={route.coords} unit={unit} />
      <div className="row actions">{actions}</div>
      {note && <p className="note">{note}</p>}
      <ul className="legend">
        <li><span className="key key-likely" /> Likely stop: a signal or a road of 5 or more lanes</li>
        <li><span className="key key-other" /> Other crossing, usually quick</li>
        <li><span className="key key-signal" /> Ringed: traffic signal</li>
        <li><span className="key key-gap" /> No mapped sidewalk</li>
        {route.turnaround && <li><span className="key key-turn" /> Turnaround, also in the GPX file</li>}
      </ul>
      <details className="howto">
        <summary>How to put it on your watch</summary>
        <p><strong>COROS:</strong> in the COROS app, open Routes, choose Import, and pick the GPX file. Then sync the route to your watch.</p>
        <p><strong>Garmin:</strong> in Garmin Connect on a computer, open Training &amp; Planning, then Courses, choose Import, and select the GPX file. Then send the course to your device.</p>
      </details>
    </>
  );
}

// Builds the GPX file in the browser and hands it to the visitor.
export function downloadGpx(route: RouteOption, name: string, fileName: string) {
  const gpx = toGpx(name, route.coords, route.turnaround ? [turnaroundOf(route.coords)] : []);
  const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
