'use client';
import { useEffect, useRef } from 'react';
import type { GeoJSONSource, Map as MlMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { RouteOption } from '@runway/routing/service';

export type Point = { lat: number; lon: number };
export type Focus = { lat: number; lon: number; bbox?: [south: number, north: number, west: number, east: number] };

type Props = {
  start: Point | null;
  route: RouteOption | null;
  focus: Focus | null;
  onPick: (p: Point, zoom: number) => void;
};

const STYLE = process.env.NEXT_PUBLIC_MAP_STYLE || 'https://tiles.openfreemap.org/styles/liberty';
type Geometry = { type: 'LineString'; coordinates: number[][] } | { type: 'Point'; coordinates: number[] };
type Feature = { type: 'Feature'; properties: Record<string, unknown>; geometry: Geometry };
const collection = (features: Feature[]) => ({ type: 'FeatureCollection' as const, features });

function dot(className: string, label: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  el.setAttribute('aria-label', label);
  el.title = label;
  return el;
}

export default function RouteMap({ start, route, focus, onPick }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const lib = useRef<typeof import('maplibre-gl') | null>(null);
  const ready = useRef(false);
  const markers = useRef<{ start?: Marker; turn?: Marker }>({});
  const fitted = useRef<RouteOption | null>(null);
  const latest = useRef({ start, route, onPick });
  latest.current = { start, route, onPick };

  // Draws the latest start, route and stops. Safe to call before the map has loaded.
  const sync = () => {
    const m = map.current;
    const ml = lib.current;
    if (!m || !ml || !ready.current) return;
    const { start: s, route: r } = latest.current;

    const routeLine: Feature[] = r ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.coords.map((c) => [c[0], c[1]]) } }] : [];
    const gaps: Feature[] = (r?.noSidewalk ?? []).map((line) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } }));
    const stops: Feature[] = (r?.stops ?? []).map((e) => ({ type: 'Feature', properties: { likely: e.likely, signal: e.signal }, geometry: { type: 'Point', coordinates: [e.lon, e.lat] } }));
    (m.getSource('route') as GeoJSONSource).setData(collection(routeLine));
    (m.getSource('gaps') as GeoJSONSource).setData(collection(gaps));
    (m.getSource('stops') as GeoJSONSource).setData(collection(stops));

    markers.current.start?.remove();
    markers.current.start = s ? new ml.Marker({ element: dot('marker-start', 'Start') }).setLngLat([s.lon, s.lat]).addTo(m) : undefined;
    markers.current.turn?.remove();
    markers.current.turn = r?.turnaround ? new ml.Marker({ element: dot('marker-turn', 'Turnaround') }).setLngLat([r.turnaround.lon, r.turnaround.lat]).addTo(m) : undefined;

    if (r && fitted.current !== r) {
      fitted.current = r;
      const b = new ml.LngLatBounds();
      for (const c of r.coords) b.extend([c[0], c[1]]);
      m.fitBounds(b, { padding: 50, duration: 600, maxZoom: 16 });
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ml = await import('maplibre-gl');
      if (cancelled || !box.current) return;
      lib.current = ml;
      ml.setWorkerUrl('/maplibre-gl-worker.mjs');
      const m = new ml.Map({ container: box.current, style: STYLE, center: [-40, 38], zoom: 1.6, attributionControl: { compact: true } });
      map.current = m;
      m.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
      const setZoom = () => box.current?.setAttribute('data-zoom', m.getZoom().toFixed(1));
      setZoom();
      m.on('moveend', setZoom);
      m.on('click', (e) => latest.current.onPick({ lat: e.lngLat.lat, lon: e.lngLat.lng }, m.getZoom()));
      m.on('load', () => {
        m.addSource('route', { type: 'geojson', data: collection([]) });
        m.addSource('gaps', { type: 'geojson', data: collection([]) });
        m.addSource('stops', { type: 'geojson', data: collection([]) });
        m.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8 } });
        m.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0b6bcb', 'line-width': 5 } });
        m.addLayer({ id: 'gaps', type: 'line', source: 'gaps', layout: { 'line-cap': 'butt' }, paint: { 'line-color': '#8a2be2', 'line-width': 4, 'line-dasharray': [1.5, 1.2] } });
        m.addLayer({
          id: 'stops',
          type: 'circle',
          source: 'stops',
          paint: {
            'circle-radius': ['case', ['get', 'likely'], 7, 4],
            'circle-color': ['case', ['get', 'likely'], '#d62828', '#8c8c8c'],
            'circle-stroke-color': ['case', ['get', 'signal'], '#1a1a1a', '#ffffff'],
            'circle-stroke-width': ['case', ['get', 'signal'], 2.5, 1.5],
          },
        });
        ready.current = true;
        box.current?.setAttribute('data-ready', 'true');
        sync();
      });
    })();
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      ready.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(sync, [start, route]);

  useEffect(() => {
    const m = map.current;
    if (!m || !focus) return;
    // Show the whole place where it fits, but always close enough to set a start (zoom 12 or more).
    let zoom = 14;
    if (focus.bbox) {
      const [south, north, west, east] = focus.bbox;
      zoom = m.cameraForBounds([[west, south], [east, north]], { padding: 30 })?.zoom ?? 14;
    }
    m.flyTo({ center: [focus.lon, focus.lat], zoom: Math.min(15, Math.max(12, zoom)), duration: 800 });
  }, [focus]);

  return <div ref={box} className="map" data-testid="map" role="application" aria-label="Map. Click or tap to set the start point." />;
}
