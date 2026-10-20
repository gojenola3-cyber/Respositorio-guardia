import { EVENT_TYPES, type AgendaKind } from '@guardia/core';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text } from 'react-native';

import { KIND_LABEL } from '@/agenda';
import { useSession } from '@/session';
import { supabase } from '@/supabase';
import { Badge, Button, Card, Muted, Row, Screen } from '@/ui';

const fmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Agenda compartida: lista con filtro por tipo; próximos o realizados.
export default function Agenda() {
  const { membership } = useSession();
  const router = useRouter();
  const [kind, setKind] = useState<AgendaKind | 'all'>('all');
  const [past, setPast] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [mine, setMine] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!membership) return;
    const now = new Date().toISOString();
    let q = supabase.from('agenda_items').select('*').eq('org_id', membership.orgId);
    q = past ? q.lt('ends_at', now).order('starts_at', { ascending: false }) : q.gte('ends_at', now).order('starts_at');
    if (kind !== 'all') q = q.eq('kind', kind);
    const { data } = await q.limit(100);
    setItems(data ?? []);
    const { data: es } = await supabase.from('event_signups').select('event_id').eq('member_id', membership.id).neq('status', 'cancelled');
    const { data: ss } = await supabase.from('shift_signups').select('shift_id').eq('member_id', membership.id).neq('status', 'cancelled');
    setMine(new Set([...(es ?? []).map((x: any) => x.event_id), ...(ss ?? []).map((x: any) => x.shift_id)]));
  }, [membership, kind, past]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <Screen>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {(['all', 'shift', ...EVENT_TYPES] as const).map((k) => (
          <Button key={k} variant={kind === k ? 'primary' : 'neutral'} label={k === 'all' ? 'Todo' : KIND_LABEL[k]} onPress={() => setKind(k)} />
        ))}
      </ScrollView>
      <Row>
        <Button variant={!past ? 'primary' : 'neutral'} label="Próximos" onPress={() => setPast(false)} />
        <Button variant={past ? 'primary' : 'neutral'} label="Realizados" onPress={() => setPast(true)} />
      </Row>
      {!items.length && <Muted>No hay nada en la agenda.</Muted>}
      {items.map((i) => (
        <Pressable key={`${i.kind}-${i.id}`} accessibilityRole="button"
          onPress={() => router.push(i.kind === 'shift' ? { pathname: '/guardia/[id]', params: { id: i.id } } : { pathname: '/evento/[id]', params: { id: i.id } })}>
          <Card>
            <Row>
              <Badge tone="info" text={KIND_LABEL[i.kind as AgendaKind]} />
              {i.status === 'cancelled' && <Badge tone="neutral" icon="⛔" text="Cancelado" />}
              {mine.has(i.id) && <Badge tone="success" icon="✅" text="Inscrito" />}
            </Row>
            <Text style={{ fontSize: 18, fontWeight: '700' }}>{i.title}</Text>
            <Muted>{fmt.format(new Date(i.starts_at))}{i.location_text ? ` · ${i.location_text}` : ''}</Muted>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
