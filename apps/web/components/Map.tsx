'use client';
import 'leaflet/dist/leaflet.css';

import type { Freshness, LatLng } from '@guardia/core';
import { useEffect, useRef } from 'react';

export interface MapPoint extends LatLng {
  id: string;
  label: string;
  kind: 'emergency' | 'base' | 'volunteer';
  freshness?: Freshness;
}

// Proveedor de teselas configurable: cambiar de proveedor es cambiar la variable.
const TILE_URL = process.env.NEXT_PUBLIC_MAP_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = process.env.NEXT_PUBLIC_MAP_ATTRIBUTION ?? '© OpenStreetMap contributors';

const COLORS = {
  emergency: '#c8102e',
  base: '#16335c',
  fresh: '#157a3b',
  stale: '#a35f00',
  old: '#6b7280',
};
const FRESH_LABEL = { fresh: 'actualizada', stale: 'desfasada', old: 'antigua' } as const;

/** Mapa del panel (Leaflet, solo en el navegador). */
export function MapView({
  points,
  onPick,
  center = { lat: 43.3606, lng: -2.5057 },
  className = 'map',
}: {
  points: MapPoint[];
  onPick?: (p: LatLng) => void;
  center?: LatLng;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<import('leaflet').Map | null>(null);
  const layer = useRef<import('leaflet').LayerGroup | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const fitted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    import('leaflet').then((L) => {
      if (cancelled || !el.current || map.current) return;
      map.current = L.map(el.current).setView([center.lat, center.lng], 13);
      L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map.current);
      layer.current = L.layerGroup().addTo(map.current);
      map.current.on('click', (e) => pickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
      draw(L);
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    import('leaflet').then((L) => draw(L));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]);

  function draw(L: typeof import('leaflet')) {
    if (!map.current || !layer.current) return;
    layer.current.clearLayers();
    for (const p of points) {
      const color = p.kind === 'volunteer' ? COLORS[p.freshness ?? 'old'] : COLORS[p.kind];
      const text = p.kind === 'volunteer' && p.freshness ? `${p.label} (${FRESH_LABEL[p.freshness]})` : p.label;
      L.circleMarker([p.lat, p.lng], {
        radius: p.kind === 'volunteer' ? 9 : 12,
        color,
        fillColor: color,
        fillOpacity: p.freshness === 'old' ? 0.35 : 0.9,
        dashArray: p.freshness === 'old' ? '4 4' : undefined,
      })
        .bindTooltip(text, { permanent: true, direction: 'right' })
        .addTo(layer.current);
    }
    if (points.length && !fitted.current) {
      fitted.current = true;
      map.current.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng])), { padding: [40, 40], maxZoom: 15 });
    }
  }

  return <div ref={el} className={className} role="application" aria-label="Mapa" />;
}
