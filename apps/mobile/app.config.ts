import type { ExpoConfig } from 'expo/config';

// Activar SOLO cuando Apple haya concedido el entitlement de alertas
// críticas (ver docs/NOTIFICACIONES.md). Sin concesión, el build falla al firmar.
const CRITICAL_ALERTS = process.env.IOS_CRITICAL_ALERTS === '1';

// Cambia los identificadores por los de tu organización antes del primer build.
const BUNDLE_ID = process.env.APP_BUNDLE_ID ?? 'org.example.guardia';

export default (): ExpoConfig => ({
  name: 'Guardia',
  slug: 'guardia',
  scheme: 'guardia',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: true,
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        'Solo si aceptas acudir a una emergencia y lo autorizas: los responsables ven cuánto te falta para llegar a la base.',
      ITSAppUsesNonExemptEncryption: false,
    },
    entitlements: {
      'com.apple.developer.usernotifications.time-sensitive': true,
      ...(CRITICAL_ALERTS ? { 'com.apple.developer.usernotifications.critical-alerts': true } : {}),
    },
  },
  android: {
    package: BUNDLE_ID,
    permissions: ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'POST_NOTIFICATIONS', 'VIBRATE'],
    // El seguimiento es en primer plano en esta versión: no se pide ubicación
    // en segundo plano (exige declaración específica en Google Play).
    blockedPermissions: ['android.permission.ACCESS_BACKGROUND_LOCATION', 'android.permission.USE_FULL_SCREEN_INTENT'],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    ['expo-notifications', { sounds: ['./assets/sounds/emergency.wav'], color: '#c8102e' }],
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'Solo si aceptas acudir a una emergencia y lo autorizas: los responsables ven cuánto te falta para llegar a la base.',
        isIosBackgroundLocationEnabled: false,
        isAndroidBackgroundLocationEnabled: false,
      },
    ],
  ],
  extra: { eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID } },
});
