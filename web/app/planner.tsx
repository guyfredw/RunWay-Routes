'use client';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { toGpx, turnaroundOf } from '@runway/routing';
import type { RouteResponse } from '@runway/routing/service';
import type { Focus, Point } from './route-map';
import Elevation from './elevation';

const RouteMap = dynamic(() => import('./route-map'), { ssr: false, loading: () => <div className="map map-loading">Loading map…</div> });

type Place = { name: string; lat: number; lon: number; bbox: [number, number, number, number] };
type Unit = 'km' | 'mi';
type CourseType = 'loop' | 'out-and-back';

const KM_PER_MI = 1.609344;
const MIN_PICK_ZOOM = 12;
const LIMITS: Record<Unit, [number, number]> = { km: [1, 42], mi: [0.7, 26] };

async function post<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    return res.ok ? { ok: true, data } : { ok: false, error: data.error ?? 'Something went wrong. Try again.' };
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
  }
}

export default function Planner() {
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [focus, setFocus] = useState<Focus | null>(null);

  const [start, setStart] = useState<Point | null>(null);
  const [pickHint, setPickHint] = useState('');
  const [unit, setUnit] = useState<Unit>('km');
  const [distance, setDistance] = useState('5');
  const [type, setType] = useState<CourseType>('loop');

  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [lo, hi] = LIMITS[unit];
  const distanceNum = Number(distance);
  const distanceOk = Number.isFinite(distanceNum) && distanceNum >= lo && distanceNum <= hi;
  const fmtDist = (m: number) => (unit === 'km' ? `${(m / 1000).toFixed(2)} km` : `${(m / 1000 / KM_PER_MI).toFixed(2)} mi`);
  const fmtClimb = (m: number) => (unit === 'km' ? `${m} m` : `${Math.round(m * 3.28084)} ft`);

  // Any change to the request clears the old route, so the map never shows a stale one.
  const resetRoute = () => {
    setRoute(null);
    setError('');
  };

  async function search(e: FormEvent) {
    e.preventDefault();
    if (query.trim().length < 2) return;
    setSearching(true);
    setSearchError('');
    const r = await post<{ places: Place[] }>('/api/search', { q: query });
    setSearching(false);
    if (!r.ok) return setSearchError(r.error);
    setPlaces(r.data.places);
    if (r.data.places.length === 1) choosePlace(r.data.places[0]);
  }

  function choosePlace(p: Place) {
    setFocus({ lat: p.lat, lon: p.lon, bbox: p.bbox });
    setPlaces(null);
    setPickHint('');
  }

  function pick(p: Point, zoom: number) {
    if (zoom < MIN_PICK_ZOOM) {
      setPickHint('Zoom in closer to set an exact start point.');
      return;
    }
    setPickHint('');
    setStart(p);
    resetRoute();
  }

  function changeUnit(next: Unit) {
    if (next === unit) return;
    const converted = next === 'mi' ? distanceNum / KM_PER_MI : distanceNum * KM_PER_MI;
    if (Number.isFinite(converted) && converted > 0) setDistance(String(Math.round(converted * 10) / 10));
    setUnit(next);
    resetRoute();
  }

  async function generate(variant: number) {
    if (!start || !distanceOk) return;
    setLoading(true);
    setError('');
    const distanceKm = Math.round((unit === 'km' ? distanceNum : distanceNum * KM_PER_MI) * 1000) / 1000;
    const r = await post<RouteResponse>('/api/route', { lat: start.lat, lon: start.lon, distanceKm, type, variant });
    setLoading(false);
    if (!r.ok) {
      setRoute(null);
      return setError(r.error);
    }
    setRoute(r.data);
  }

  function download() {
    if (!route) return;
    const label = `${distance} ${unit} ${type === 'loop' ? 'loop' : 'out-and-back'}`;
    const gpx = toGpx(`RunWay ${label}`, route.coords, route.type === 'out-and-back' ? [turnaroundOf(route.coords)] : []);
    const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `runway-${label.replace(/ /g, '-')}.gpx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="app">
      <section className="top" aria-label="Find your area">
        <header>
          <h1>RunWay Routes</h1>
          <p className="tagline">Running routes with fewer stops, ready for your watch.</p>
        </header>

        <form className="search" onSubmit={search} role="search">
          <label htmlFor="q">1. Find your area</label>
          <div className="row">
            <input id="q" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Address, place or ZIP code" autoComplete="off" />
            <button type="submit" disabled={searching || query.trim().length < 2}>
              {searching ? 'Searching…' : 'Search'}
            </button>
          </div>
          {searchError && <p className="error">{searchError}</p>}
          {places && places.length === 0 && <p className="note">No places found. Try a fuller address or a ZIP code.</p>}
          {places && places.length > 1 && (
            <ul className="places">
              {places.map((p) => (
                <li key={`${p.lat},${p.lon},${p.name}`}>
                  <button type="button" onClick={() => choosePlace(p)}>{p.name}</button>
                </li>
              ))}
            </ul>
          )}
        </form>
      </section>

      <div className="map-wrap">
        <RouteMap start={start} route={route} focus={focus} onPick={pick} />
      </div>

      <section className="panel" aria-label="Route options">
        <div className="step">
          <p className="label">2. Set the start</p>
          <p className="note" aria-live="polite">{pickHint || (start ? 'Start set. Click the map again to move it.' : 'Click or tap the map where you want to start.')}</p>
        </div>

        <fieldset className="step">
          <legend className="label">3. Choose options</legend>
          <div className="row">
            <label className="distance">
              <span className="sr-only">Distance</span>
              <input type="number" inputMode="decimal" min={lo} max={hi} step="0.1" value={distance} onChange={(e) => { setDistance(e.target.value); resetRoute(); }} aria-label="Distance" />
            </label>
            <div className="toggle" role="radiogroup" aria-label="Units">
              {(['km', 'mi'] as Unit[]).map((u) => (
                <button key={u} type="button" role="radio" aria-checked={unit === u} onClick={() => changeUnit(u)}>{u}</button>
              ))}
            </div>
          </div>
          {!distanceOk && <p className="error">Choose a distance from {lo} to {hi} {unit}.</p>}
          <div className="toggle wide" role="radiogroup" aria-label="Course type">
            {([['loop', 'Loop'], ['out-and-back', 'Out and back']] as [CourseType, string][]).map(([t, label]) => (
              <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => { setType(t); resetRoute(); }}>{label}</button>
            ))}
          </div>
        </fieldset>

        <button className="primary" type="button" disabled={!start || !distanceOk || loading} onClick={() => generate(0)}>
          {loading ? 'Finding a route…' : 'Generate route'}
        </button>
        {loading && <p className="note">This can take up to 10 seconds.</p>}
        {error && <p className="error" role="alert">{error}</p>}

        {route && (
          <div className="results" aria-live="polite">
            <dl className="summary">
              <div><dt>Distance</dt><dd data-testid="distance">{fmtDist(route.distanceM)}</dd></div>
              <div><dt>Likely stops</dt><dd data-testid="likely-stops">{route.summary.likelyStops}</dd></div>
              <div><dt>Other crossings</dt><dd>{route.summary.otherCrossings}</dd></div>
              <div><dt>Climb</dt><dd>{fmtClimb(route.gainM)}</dd></div>
            </dl>
            {route.warnings.length > 0 && (
              <ul className="warnings">
                {route.warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            )}
            <Elevation coords={route.coords} unit={unit} />
            <div className="row actions">
              <button className="primary" type="button" onClick={download}>Download GPX</button>
              <button type="button" disabled={loading || route.options < 2} onClick={() => generate(route.variant + 1)}>
                Generate another
              </button>
            </div>
            <p className="note">
              {route.options < 2 ? 'This is the only route found from this start.' : `Route ${route.variant + 1} of ${route.options}.`}
            </p>
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
          </div>
        )}

        <footer className="footer">
          <p>Routes and stop counts are estimates from map data. They aren&apos;t guaranteed to be safe, accurate or passable, so follow traffic rules and use your own judgment.</p>
          <p>Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>. Search by <a href="https://nominatim.org/">Nominatim</a>, map tiles by <a href="https://openfreemap.org/">OpenFreeMap</a>, routing by <a href="https://github.com/abrensch/brouter">BRouter</a>.</p>
        </footer>
      </section>
    </div>
  );
}
