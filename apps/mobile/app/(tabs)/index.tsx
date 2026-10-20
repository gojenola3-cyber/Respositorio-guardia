import { errorMessage, RECIPIENT_TONE, recipientLabel, type RecipientStatus } from '@guardia/core';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, Switch, Text } from 'react-native';

import { useSession } from '@/session';
import { supabase } from '@/supabase';
import { colors } from '@/theme';
import { Badge, Card, Muted, Notice, Row, Screen, Title } from '@/ui';

const fmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Inicio: alertas activas, disponibilidad y próximas guardias.
export default function Home() {
  const { membership, refresh } = useSession();
  const router = useRouter();
  const [alerts, setAlerts] = useState<any[]>([]);
  const [shifts, setShifts] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!membership) return;
    const { data: rec, error } = await supabase.from('emergency_recipients')
      .select('id, status, emergency_id, created_at').eq('member_id', membership.id)
      .order('created_at', { ascending: false }).limit(10);
    if (error) return setError(errorMessage('es', error));
    const ids = (rec ?? []).map((r: any) => r.emergency_id);
    const { data: em } = ids.length ? await supabase.from('emergencies').select('id, title, address, status, priority').in('id', ids).eq('status', 'active') : { data: [] };
    setAlerts((rec ?? []).filter((r: any) => (em ?? []).some((e: any) => e.id === r.emergency_id))
      .map((r: any) => ({ ...r, emergency: (em ?? []).find((e: any) => e.id === r.emergency_id) })));
    const { data: su } = await supabase.from('shift_signups').select('id, status, shift_id').eq('member_id', membership.id).neq('status', 'cancelled');
    const sIds = (su ?? []).map((x: any) => x.shift_id);
    const { data: sh } = sIds.length ? await supabase.from('shifts').select('id, title, starts_at, ends_at, status').in('id', sIds)
      .gte('ends_at', new Date().toISOString()).neq('status', 'cancelled').order('starts_at').limit(5) : { data: [] };
    setShifts((sh ?? []).map((s: any) => ({ ...s, confirmed: (su ?? []).find((x: any) => x.shift_id === s.id)?.status === 'confirmed' })));
    setError(null);
  }, [membership]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => {
    if (!membership) return;
    const ch = supabase.channel(`home-${membership.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'emergency_recipients', filter: `member_id=eq.${membership.id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [membership, load]);

  async function toggleAvailability(value: boolean) {
    if (!membership) return;
    const { error } = await supabase.rpc('set_my_availability', { p_org: membership.orgId, p_availability: value ? 'available' : 'unavailable' });
    if (error) setError(errorMessage('es', error));
    refresh();
  }

  if (!membership) return null;
  const now = new Date();
  const onShift = shifts.find((s) => new Date(s.starts_at) <= now && new Date(s.ends_at) > now);

  return (
    <Screen>
      <Title>{membership.orgName}</Title>
      {error && <Notice tone="danger">{error}</Notice>}

      {alerts.map((a) => {
        const st = a.status as RecipientStatus;
        return (
          <Pressable key={a.id} onPress={() => router.push({ pathname: '/emergencia/[id]', params: { id: a.id } })} accessibilityRole="button">
            <Card style={{ borderLeftWidth: 6, borderLeftColor: colors.red600 }}>
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.red700 }}>🚨 {a.emergency.title}</Text>
              {a.emergency.address && <Muted>{a.emergency.address}</Muted>}
              <Badge tone={RECIPIENT_TONE[st].tone} text={recipientLabel('es', st)} />
              <Muted>Toca para responder o ver la ruta →</Muted>
            </Card>
          </Pressable>
        );
      })}

      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 18, fontWeight: '700', flex: 1 }}>Disponible para activaciones</Text>
          <Switch value={membership.availability === 'available'} onValueChange={toggleAvailability}
            accessibilityLabel="Disponible para activaciones" style={{ transform: [{ scale: 1.2 }] }} />
        </Row>
        <Muted>{membership.availability === 'available'
          ? 'Te pueden avisar aunque no estés de guardia.'
          : 'Solo te avisarán durante tus guardias.'}</Muted>
        {onShift ? <Badge tone="success" icon="✅" text={`De guardia ahora: ${onShift.title}`} /> : <Badge tone="neutral" text="No estás de guardia ahora" />}
      </Card>

      <Card>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Mis próximas guardias</Text>
        {shifts.length ? shifts.map((s) => (
          <Pressable key={s.id} onPress={() => router.push({ pathname: '/guardia/[id]', params: { id: s.id } })} style={{ paddingVertical: 10 }}>
            <Text style={{ fontSize: 16 }}>{fmt.format(new Date(s.starts_at))} · {s.title}</Text>
            {s.confirmed ? <Badge tone="success" icon="✅" text="Confirmada" /> : <Badge tone="info" text="Inscrito" />}
          </Pressable>
        )) : <Muted>No estás apuntado a ninguna guardia.</Muted>}
      </Card>
    </Screen>
  );
}
