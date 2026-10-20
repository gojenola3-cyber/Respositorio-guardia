import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from './supabase';

// Deben coincidir con supabase/functions/_shared/expo.ts.
export const CHANNEL_ALERTS = 'emergency-alerts';
export const CHANNEL_UPDATES = 'emergency-updates';
export const CATEGORY_RESPONSE = 'emergency_response';
export const ACTION_ACCEPT = 'accept';
export const ACTION_DECLINE = 'decline';

export interface AlertData {
  type: 'emergency_alert' | 'emergency_cancelled' | 'test';
  emergencyId?: string;
  recipientId?: string;
}

// Con la app abierta también se muestra y suena (sin bucles: una vez por aviso).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Canales Android y acciones de la notificación (iOS y Android). */
export async function configureNotificationChannels() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ALERTS, {
      name: 'Alertas de emergencia',
      description: 'Activaciones de emergencia. Recomendado: permitir que suene en No molestar.',
      importance: Notifications.AndroidImportance.MAX,
      sound: 'emergency.wav',
      vibrationPattern: [0, 800, 300, 800, 300, 800],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      enableVibrate: true,
    });
    await Notifications.setNotificationChannelAsync(CHANNEL_UPDATES, {
      name: 'Cambios y cancelaciones',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  // Las dos acciones abren la app: así la respuesta se envía de forma fiable
  // aunque el sistema hubiera cerrado la app.
  await Notifications.setNotificationCategoryAsync(CATEGORY_RESPONSE, [
    { identifier: ACTION_ACCEPT, buttonTitle: 'SÍ, ACUDO', options: { opensAppToForeground: true } },
    { identifier: ACTION_DECLINE, buttonTitle: 'NO PUEDO ACUDIR', options: { opensAppToForeground: true, isDestructive: true } },
  ]);
}

export type PushRegistration =
  | { ok: true; token: string }
  | { ok: false; reason: 'not_device' | 'denied' | 'no_project' | 'error'; detail?: string };

/** Pide permiso, obtiene el token Expo y lo registra en el servidor. */
export async function registerForPush(): Promise<PushRegistration> {
  if (!Device.isDevice) return { ok: false, reason: 'not_device' };
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') {
    status = (await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false, allowCriticalAlerts: true },
    })).status;
  }
  if (status !== 'granted') return { ok: false, reason: 'denied' };
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return { ok: false, reason: 'no_project' };
  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    const { error } = await supabase.rpc('register_push_token', {
      p_token: token,
      p_platform: Platform.OS === 'ios' ? 'ios' : 'android',
      p_device_label: Device.modelName ?? null,
      p_app_version: Constants.expoConfig?.version ?? null,
    });
    if (error) return { ok: false, reason: 'error', detail: error.message };
    return { ok: true, token };
  } catch (err) {
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function unregisterPush() {
  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId || !Device.isDevice) return;
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await supabase.rpc('unregister_push_token', { p_token: token });
  } catch {
    // Sin conexión: el token caducará solo en el servidor.
  }
}

export async function notificationPermissionSummary() {
  const p = await Notifications.getPermissionsAsync();
  return {
    granted: p.status === 'granted',
    critical: Platform.OS === 'ios' ? p.ios?.allowsCriticalAlerts === true : false,
  };
}
