import * as Notifications from 'expo-notifications';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ACTION_ACCEPT, ACTION_DECLINE, configureNotificationChannels, registerForPush, type AlertData } from '@/notifications';
import { SessionProvider, useSession } from '@/session';
import { colors } from '@/theme';

function Gate() {
  const { session, loading, membership } = useSession();
  const segments = useSegments();
  const router = useRouter();

  // Redirección según sesión y membresía.
  useEffect(() => {
    if (loading) return;
    const first = segments[0] as string | undefined;
    const inAuth = first === 'login' || first === 'recuperar';
    if (!session && !inAuth) router.replace('/login');
    else if (session && !membership && first !== 'alta') router.replace('/alta');
    else if (session && membership && (inAuth || first === 'alta')) router.replace('/');
  }, [loading, session, membership, segments, router]);

  // Registro del dispositivo para avisos al entrar.
  useEffect(() => {
    if (session && membership) registerForPush();
  }, [session, membership]);

  // Toque en la notificación o en sus botones (también en arranque en frío).
  useEffect(() => {
    const open = (resp: Notifications.NotificationResponse | null) => {
      if (!resp) return;
      const data = resp.notification.request.content.data as unknown as AlertData;
      if (!data?.emergencyId || data.type === 'test') return;
      const action = resp.actionIdentifier === ACTION_ACCEPT ? 'accept' : resp.actionIdentifier === ACTION_DECLINE ? 'decline' : undefined;
      router.push({ pathname: '/emergencia/[id]', params: { id: data.recipientId!, ...(action ? { action } : {}) } });
    };
    Notifications.getLastNotificationResponseAsync().then(open);
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    // Con la app abierta, una alerta nueva abre directamente la pantalla de respuesta.
    const recv = Notifications.addNotificationReceivedListener((n) => {
      const data = n.request.content.data as unknown as AlertData;
      if (data?.type === 'emergency_alert' && data.recipientId) {
        router.push({ pathname: '/emergencia/[id]', params: { id: data.recipientId } });
      }
    });
    return () => {
      sub.remove();
      recv.remove();
    };
  }, [router]);

  if (loading) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator size="large" /></View>;
  }
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: colors.navy900 }, headerTintColor: colors.white, headerTitleStyle: { fontWeight: '700' } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ title: 'Entrar' }} />
      <Stack.Screen name="recuperar" options={{ title: 'Recuperar acceso' }} />
      <Stack.Screen name="alta" options={{ title: 'Unirse a una organización' }} />
      <Stack.Screen name="emergencia/[id]" options={{ title: 'Emergencia', headerStyle: { backgroundColor: colors.red600 }, gestureEnabled: false }} />
      <Stack.Screen name="guardia/[id]" options={{ title: 'Guardia' }} />
      <Stack.Screen name="evento/[id]" options={{ title: 'Evento' }} />
    </Stack>
  );
}

export default function RootLayout() {
  useEffect(() => {
    configureNotificationChannels();
  }, []);
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="light" />
        <Gate />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
