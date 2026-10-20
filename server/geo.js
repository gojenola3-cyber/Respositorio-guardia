// Distancia y tiempo estimado de llegada.
// No hay ruta real por carretera: se usa la distancia en línea recta
// corregida por un factor de rodeo y una velocidad media de conducción.

const EARTH_RADIUS_KM = 6371;
export const ROAD_FACTOR = 1.4; // las carreteras de costa/montaña no son rectas
export const AVG_SPEED_KMH = 50;

const rad = (deg) => (deg * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function estimate(from, to) {
  if (!from || !to) return null;
  const straightKm = haversineKm(from, to);
  const roadKm = straightKm * ROAD_FACTOR;
  const minutes = Math.max(1, Math.round((roadKm / AVG_SPEED_KMH) * 60));
  return { km: Math.round(roadKm * 10) / 10, minutes };
}
