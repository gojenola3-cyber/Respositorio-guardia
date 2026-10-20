// Distancias, tiempo estimado y antigüedad de las posiciones GPS.

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;
/** Las carreteras no van en línea recta (costa y montaña: bastante más). */
export const ROAD_FACTOR = 1.4;
export const AVG_SPEED_KMH = 50;

const rad = (deg: number) => (deg * Math.PI) / 180;

export function isValidLatLng(p: Partial<LatLng> | null | undefined): p is LatLng {
  return (
    !!p &&
    typeof p.lat === 'number' &&
    typeof p.lng === 'number' &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export interface Estimate {
  km: number;
  minutes: number;
}

/**
 * Estimación ORIENTATIVA: línea recta × factor de rodeo a velocidad media.
 * No es una ruta real; la interfaz debe indicarlo.
 */
export function estimateArrival(from: LatLng | null, to: LatLng | null): Estimate | null {
  if (!isValidLatLng(from) || !isValidLatLng(to)) return null;
  const km = haversineKm(from, to) * ROAD_FACTOR;
  return { km: Math.round(km * 10) / 10, minutes: Math.max(1, Math.round((km / AVG_SPEED_KMH) * 60)) };
}

export type Freshness = 'fresh' | 'stale' | 'old';

export const FRESH_SECONDS = 120;
export const STALE_SECONDS = 600;

/** Actualizada (< 2 min), desfasada (< 10 min) o antigua. */
export function locationFreshness(recordedAt: Date | string, now: Date = new Date()): Freshness {
  const ageS = (now.getTime() - new Date(recordedAt).getTime()) / 1000;
  if (ageS <= FRESH_SECONDS) return 'fresh';
  if (ageS <= STALE_SECONDS) return 'stale';
  return 'old';
}

/** Enlaces para abrir la ruta en una app de navegación externa. */
export function navigationLinks(dest: LatLng, label = 'Base') {
  const { lat, lng } = dest;
  const q = encodeURIComponent(label);
  return {
    apple: `https://maps.apple.com/?daddr=${lat},${lng}&q=${q}&dirflg=d`,
    google: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`,
    waze: `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`,
  };
}
