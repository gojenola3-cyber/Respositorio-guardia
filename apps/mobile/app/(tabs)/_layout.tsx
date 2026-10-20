import { Tabs } from 'expo-router';
import { Text } from 'react-native';

import { colors } from '@/theme';

const icon = (glyph: string) => ({ color }: { color: string }) => <Text style={{ fontSize: 22, color }}>{glyph}</Text>;

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{
      headerStyle: { backgroundColor: colors.navy900 }, headerTintColor: colors.white,
      tabBarActiveTintColor: colors.navy700, tabBarLabelStyle: { fontSize: 13, fontWeight: '600' }, tabBarStyle: { minHeight: 64 },
    }}>
      <Tabs.Screen name="index" options={{ title: 'Inicio', tabBarIcon: icon('🏠') }} />
      <Tabs.Screen name="guardias" options={{ title: 'Guardias', tabBarIcon: icon('🗓') }} />
      <Tabs.Screen name="agenda" options={{ title: 'Agenda', tabBarIcon: icon('📋') }} />
      <Tabs.Screen name="historial" options={{ title: 'Historial', tabBarIcon: icon('🕘') }} />
      <Tabs.Screen name="perfil" options={{ title: 'Perfil', tabBarIcon: icon('👤') }} />
    </Tabs>
  );
}
