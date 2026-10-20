import type { Tone } from '@guardia/core';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, toneColors } from './theme';

// Componentes grandes y separados: pensados para usar con una mano y con prisa.

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const body = <View style={s.screen}>{children}</View>;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.gray100 }} edges={['bottom']}>
      {scroll ? <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>{body}</ScrollView> : body}
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={s.title} accessibilityRole="header">{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={s.muted}>{children}</Text>;
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

type Variant = 'primary' | 'danger' | 'success' | 'neutral' | 'ghost';
export function Button({
  label, onPress, variant = 'primary', big = false, disabled = false, busy = false, hint,
}: {
  label: string; onPress: () => void; variant?: Variant; big?: boolean; disabled?: boolean; busy?: boolean; hint?: string;
}) {
  const bg = { primary: colors.navy700, danger: colors.red600, success: colors.green600, neutral: colors.white, ghost: 'transparent' }[variant];
  const fg = variant === 'neutral' || variant === 'ghost' ? colors.navy900 : colors.white;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: disabled || busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [s.button, big && s.big, { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        variant === 'neutral' && { borderWidth: 1, borderColor: colors.gray300 }]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.buttonText, big && s.bigText, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

/** Estado con color, icono y texto (nunca solo color). */
export function Badge({ tone, icon, text }: { tone: Tone; icon?: string; text: string }) {
  const c = toneColors[tone];
  return (
    <View style={[s.badge, { backgroundColor: c.bg, borderColor: c.fg }]}>
      <Text style={{ color: c.fg, fontWeight: '700' }}>{icon ? `${icon} ` : ''}{text}</Text>
    </View>
  );
}

export function Notice({ children, tone = 'warning' }: { children: ReactNode; tone?: Tone }) {
  const c = toneColors[tone];
  return <View style={[s.notice, { backgroundColor: c.bg, borderLeftColor: c.fg }]}><Text style={{ color: colors.navy900 }}>{children}</Text></View>;
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' }, style]}>{children}</View>;
}

export const s = StyleSheet.create({
  screen: { padding: 16, gap: 14 },
  title: { fontSize: 24, fontWeight: '800', color: colors.navy900 },
  muted: { color: colors.gray500, fontSize: 15 },
  card: { backgroundColor: colors.white, borderRadius: 14, padding: 16, gap: 10, shadowColor: colors.navy900, shadowOpacity: 0.06, shadowRadius: 8, elevation: 1 },
  button: { minHeight: 52, borderRadius: 12, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 17, fontWeight: '700' },
  big: { minHeight: 88, borderRadius: 16 },
  bigText: { fontSize: 24, fontWeight: '900', letterSpacing: 0.5 },
  badge: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  notice: { borderLeftWidth: 4, borderRadius: 8, padding: 12 },
  input: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.gray300, borderRadius: 12, padding: 14, fontSize: 17, minHeight: 52 },
  label: { fontWeight: '700', color: colors.navy900, marginBottom: 6, fontSize: 16 },
});
