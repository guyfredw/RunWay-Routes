'use client';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { DrawShape, RouteOption, RouteResponse } from '@runway/routing/service';
import type { Focus, Point } from './route-map';
import RouteDetails, { KM_PER_MI, downloadGpx, fmtDist } from './route-details';
import type { Unit } from './route-details';

const RouteMap = dynamic(() => import('./route-map'), { ssr: false, loading: () => <div className="map map-loading">Loading map…</div> });

type Place = { name: string; lat: number; lon: number; bbox: [number, number, number, number] };
type CourseType = 'loop' | 'out-and-back';
type Mode = 'generate' | 'draw';

const PER_PAGE = 3; // matches the route service
const MAX_POINTS = 100; // matches the route service
const DRAW_DELAY_MS = 250; // wait for quick clicks to settle before asking the server
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

  const [mode, setMode] = useState<Mode>('generate');
  const [pickHint, setPickHint] = useState('');
  const [unit, setUnit] = useState<Unit>('km');

  // Generate mode
  const [start, setStart] = useState<Point | null>(null);
  const [distance, setDistance] = useState('5');
  const [type, setType] = useState<CourseType>('loop');
  const [result, setResult] = useState<RouteResponse | null>(null);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generated = result?.options[selected] ?? null;

  // Draw mode
  const [points, setPoints] = useState<Point[]>([]);
  const [shape, setShape] = useState<DrawShape>('as-drawn');
  const [drawn, setDrawn] = useState<RouteOption | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [drawError, setDrawError] = useState('');
  const drawRequest = useRef(0);

  const [lo, hi] = LIMITS[unit];
  const distanceNum = Number(distance);
  const distanceOk = Number.isFinite(distanceNum) && distanceNum >= lo && distanceNum <= hi;

  // Any change to the request clears the old route, so the map never shows a stale one.
  const resetRoute = () => {
    setResult(null);
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
      setPickHint(mode === 'draw' ? 'Zoom in closer to add exact points.' : 'Zoom in closer to set an exact start point.');
      return;
    }
    setPickHint('');
    if (mode === 'generate') {
      setStart(p);
      resetRoute();
    } else if (points.length >= MAX_POINTS) {
      setPickHint(`A drawn route can have up to ${MAX_POINTS} points.`);
    } else setPoints([...points, p]);
  }

  function changeUnit(next: Unit) {
    if (next === unit) return;
    const converted = next === 'mi' ? distanceNum / KM_PER_MI : distanceNum * KM_PER_MI;
    if (Number.isFinite(converted) && converted > 0) setDistance(String(Math.round(converted * 10) / 10));
    setUnit(next);
    resetRoute();
  }

  async function generate(page: number) {
    if (!start || !distanceOk) return;
    setLoading(true);
    setError('');
    const distanceKm = Math.round((unit === 'km' ? distanceNum : distanceNum * KM_PER_MI) * 1000) / 1000;
    const r = await post<RouteResponse>('/api/route', { lat: start.lat, lon: start.lon, distanceKm, type, page });
    setLoading(false);
    if (!r.ok) {
      setResult(null);
      return setError(r.error);
    }
    setResult(r.data);
    setSelected(0);
  }

  // Redraws the route shortly after the points or shape change. Older answers are ignored.
  useEffect(() => {
    if (points.length < 2) {
      setDrawn(null);
      setDrawError('');
      return;
    }
    const id = ++drawRequest.current;
    const timer = setTimeout(async () => {
      setDrawing(true);
      const r = await post<RouteOption>('/api/draw', { points: points.map((p) => [p.lat, p.lon]), shape });
      if (id !== drawRequest.current) return;
      setDrawing(false);
      if (r.ok) {
        setDrawn(r.data);
        setDrawError('');
      } else setDrawError(r.error);
    }, DRAW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [points, shape]);

  const routeNumber = (i: number) => (result ? result.page * PER_PAGE + i + 1 : i + 1);
  const courseLabel = type === 'loop' ? 'loop' : 'out-and-back';

  function downloadGenerated() {
    if (!generated) return;
    const label = `${distance} ${unit} ${courseLabel}${routeNumber(selected) > 1 ? ` route ${routeNumber(selected)}` : ''}`;
    downloadGpx(generated, `RunWay ${label}`, `runway-${label.replace(/ /g, '-')}.gpx`);
  }

  function downloadDrawn() {
    if (!drawn) return;
    const dist = fmtDist(drawn.distanceM, unit).replace(/\.?0+ /, ' ');
    downloadGpx(drawn, `RunWay drawn ${dist}`, `runway-drawn-${dist.replace(/ /g, '-')}.gpx`);
  }

  const unitToggle = (
    <div className="toggle" role="radiogroup" aria-label="Units">
      {(['km', 'mi'] as Unit[]).map((u) => (
        <button key={u} type="button" role="radio" aria-checked={unit === u} onClick={() => changeUnit(u)}>{u}</button>
      ))}
    </div>
  );

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

        <div className="toggle wide modes" role="radiogroup" aria-label="How to plan">
          {([['generate', 'Generate a route'], ['draw', 'Draw your own']] as [Mode, string][]).map(([m, label]) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => { setMode(m); setPickHint(''); }}>{label}</button>
          ))}
        </div>
      </section>

      <div className="map-wrap">
        <RouteMap
          start={mode === 'generate' ? start : points[0] ?? null}
          points={mode === 'draw' ? points : []}
          route={mode === 'generate' ? generated : drawn}
          fitRoute={mode === 'generate'}
          focus={focus}
          onPick={pick}
        />
      </div>

      <section className="panel" aria-label={mode === 'generate' ? 'Route options' : 'Draw your route'}>
        {mode === 'generate' ? (
          <>
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
                {unitToggle}
              </div>
              {!distanceOk && <p className="error">Choose a distance from {lo} to {hi} {unit}.</p>}
              <div className="toggle wide" role="radiogroup" aria-label="Course type">
                {([['loop', 'Loop'], ['out-and-back', 'Out and back']] as [CourseType, string][]).map(([t, label]) => (
                  <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => { setType(t); resetRoute(); }}>{label}</button>
                ))}
              </div>
            </fieldset>

            <button className="primary" type="button" disabled={!start || !distanceOk || loading} onClick={() => generate(0)}>
              {loading ? 'Finding routes…' : 'Generate route'}
            </button>
            {loading && <p className="note">This can take up to 10 seconds.</p>}
            {error && <p className="error" role="alert">{error}</p>}

            {result && generated && (
              <div className="results" aria-live="polite">
                {!result.meetsRules && (
                  <p className="closest" role="status">
                    No route from here meets every rule. These are the closest matches. Each one lists what it misses.
                  </p>
                )}
                {result.options.length > 1 && (
                  <div className="tabs" role="tablist" aria-label="Routes">
                    {result.options.map((o, i) => (
                      <button key={i} type="button" role="tab" aria-selected={i === selected} onClick={() => setSelected(i)}>
                        <span>Route {routeNumber(i)}</span>
                        <small>{fmtDist(o.distanceM, unit)}</small>
                        <small>{o.summary.likelyStops} likely {o.summary.likelyStops === 1 ? 'stop' : 'stops'}</small>
                      </button>
                    ))}
                  </div>
                )}
                <RouteDetails
                  route={generated}
                  unit={unit}
                  actions={
                    <>
                      <button className="primary" type="button" onClick={downloadGenerated}>Download GPX</button>
                      <button type="button" disabled={loading || result.pages < 2} onClick={() => generate(result.page + 1)}>
                        {loading ? 'Loading…' : 'Show more routes'}
                      </button>
                    </>
                  }
                  note={
                    result.pages < 2
                      ? result.options.length < 2 ? 'This is the only route found from this start.' : 'These are all the different routes found from this start.'
                      : `Set ${result.page + 1} of ${result.pages}.`
                  }
                />
              </div>
            )}
          </>
        ) : (
          <>
            <div className="step">
              <p className="label">2. Draw your route</p>
              <p className="note" aria-live="polite">
                {pickHint || (points.length === 0 ? 'Click or tap the map to add your start, then keep adding points. The route follows roads and paths between them.' : points.length === 1 ? 'Start set. Add the next point.' : `${points.length} points. Keep clicking to extend the route.`)}
              </p>
              <div className="row">
                <button type="button" disabled={points.length === 0} onClick={() => setPoints(points.slice(0, -1))}>Undo point</button>
                <button type="button" disabled={points.length === 0} onClick={() => setPoints([])}>Clear</button>
                {unitToggle}
              </div>
            </div>

            <fieldset className="step">
              <legend className="label">3. Finish</legend>
              <div className="toggle wide" role="radiogroup" aria-label="How the route ends">
                {([['as-drawn', 'As drawn'], ['loop', 'Back to start'], ['out-and-back', 'Out and back']] as [DrawShape, string][]).map(([s, label]) => (
                  <button key={s} type="button" role="radio" aria-checked={shape === s} onClick={() => setShape(s)}>{label}</button>
                ))}
              </div>
              <p className="note">
                {shape === 'loop' ? 'Routes from your last point back to the start.' : shape === 'out-and-back' ? 'Comes back the same way, with a turnaround marker.' : 'Ends at your last point.'}
              </p>
            </fieldset>

            {drawing && <p className="note">Updating the route…</p>}
            {drawError && <p className="error" role="alert">{drawError}</p>}

            {drawn && points.length >= 2 && (
              <div className="results" aria-live="polite">
                <RouteDetails route={drawn} unit={unit} actions={<button className="primary" type="button" onClick={downloadDrawn}>Download GPX</button>} />
              </div>
            )}
          </>
        )}

        <footer className="footer">
          <p>Routes and stop counts are estimates from map data. They aren&apos;t guaranteed to be safe, accurate or passable, so follow traffic rules and use your own judgment.</p>
          <p>Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>. Search by <a href="https://nominatim.org/">Nominatim</a>, map tiles by <a href="https://openfreemap.org/">OpenFreeMap</a>, routing by <a href="https://github.com/abrensch/brouter">BRouter</a>.</p>
        </footer>
      </section>
    </div>
  );
}
