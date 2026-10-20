import * as Location from 'expo-location';

import { supabase } from './supabase';

export type TrackingState =
  | { kind: 'idle' }
  | { kind: 'denied' }
  | { kind: 'tracking'; lastSentAt: Date | null; accuracy: number | null; position: { lat: number; lng: number } | null }
  | { kind: 'error'; message: string };

/**
 * Seguimiento en PRIMER PLANO mientras la pantalla de emergencia está abierta.
 * Si la app pasa a segundo plano, iOS/Android pueden dejar de enviar
 * posiciones: la interfaz lo advierte y ofrece la navegación externa.
 */
export async function startTracking(recipientId: string, onState: (s: TrackingState) => void) {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') {
    onState({ kind: 'denied' });
    return null;
  }
  let lastSent = 0;
  onState({ kind: 'tracking', lastSentAt: null, accuracy: null, position: null });
  return Location.watchPositionAsync(
    { accuracy: Location.Accuracy.High, timeInterval: 10_000, distanceInterval: 20 },
    async (pos) => {
      if (Date.now() - lastSent < 8_000) return;
      lastSent = Date.now();
      const { error } = await supabase.rpc('report_location', {
        p_recipient: recipientId,
        p_lat: pos.coords.latitude,
        p_lng: pos.coords.longitude,
        p_accuracy_m: pos.coords.accuracy != null ? Math.round(pos.coords.accuracy) : null,
        p_recorded_at: new Date(pos.timestamp).toISOString(),
      });
      if (error) onState({ kind: 'error', message: error.message });
      else onState({
        kind: 'tracking',
        lastSentAt: new Date(),
        accuracy: pos.coords.accuracy ?? null,
        position: { lat: pos.coords.latitude, lng: pos.coords.longitude },
      });
    },
  );
}
