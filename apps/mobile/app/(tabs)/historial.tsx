import { RECIPIENT_TONE, recipientLabel, type RecipientStatus } from '@guardia/core';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text } from 'react-native';

import { useSession } from '@/session';
import { supabase } from '@/supabase';
import { Badge, Button, Card, Muted, Row, Screen } from '@/ui';

const fmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// Mis activaciones y mis guardias pasadas.
export default function History() {
  const { membership } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<'alerts' | 'shifts'>('alerts');
  const [alerts, setAlerts] = useState<any[]>([]);
  const [shifts, setShifts] = useState<any[]>([]);

  const load = useCallback(async () => {
    if (!membership) return;
    const { data: rec } = await supabase.from('emergency_recipients').select('id, status, emergency_id, responded_at, arrived_at, created_at')
      .eq('member_id', membership.id).order('created_at', { ascending: false }).limit(100);
    const ids = (rec ?? []).map((r: any) => r.emergency_id);
    const { data: em } = ids.length ? await supabase.from('emergencies').select('id, title, status').in('id', ids) : { data: [] };
    setAlerts((rec ?? []).map((r: any) => ({ ...r, emergency: (em ?? []).find((e: any) => e.id === r.emergency_id) })));
    const { data: su } = await supabase.from('shift_signups').select('shift_id, status').eq('member_id', membership.id).neq('status', 'cancelled');
    const sIds = (su ?? []).map((x: any) => x.shift_id);
    const { data: sh } = sIds.length ? await supabase.from('shifts').select('id, title, starts_at, ends_at').in('id', sIds)
      .lt('ends_at', new Date().toISOString()).order('starts_at', { ascending: false }).limit(100) : { data: [] };
    setShifts(sh ?? []);
  }, [membership]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <Screen>
      <Row>
        <Button variant={tab === 'alerts' ? 'primary' : 'neutral'} label={`Activaciones (${alerts.length})`} onPress={() => setTab('alerts')} />
        <Button variant={tab === 'shifts' ? 'primary' : 'neutral'} label={`Guardias (${shifts.length})`} onPress={() => setTab('shifts')} />
      </Row>
      {tab === 'alerts' ? alerts.map((a) => {
        const st = a.status as RecipientStatus;
        return (
          <Pressable key={a.id} onPress={() => router.push({ pathname: '/emergencia/[id]', params: { id: a.id } })} accessibilityRole="button">
            <Card>
              <Text style={{ fontSize: 17, fontWeight: '700' }}>{a.emergency?.title ?? 'Emergencia'}</Text>
              <Muted>{fmt.format(new Date(a.created_at))}</Muted>
              <Row><Badge tone={RECIPIENT_TONE[st].tone} text={recipientLabel('es', st)} />
                {a.emergency?.status !== 'active' && <Badge tone="neutral" text={a.emergency?.status === 'cancelled' ? 'Cancelada' : 'Cerrada'} />}</Row>
            </Card>
          </Pressable>
        );
      }) : shifts.map((s) => (
        <Card key={s.id}><Text style={{ fontSize: 17, fontWeight: '700' }}>{s.title}</Text><Muted>{fmt.format(new Date(s.starts_at))}</Muted></Card>
      ))}
      {tab === 'alerts' && !alerts.length && <Muted>Todavía no has recibido activaciones.</Muted>}
      {tab === 'shifts' && !shifts.length && <Muted>Aún no hay guardias realizadas.</Muted>}
    </Screen>
  );
}
