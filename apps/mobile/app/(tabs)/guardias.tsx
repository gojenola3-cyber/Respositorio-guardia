import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text } from 'react-native';

import { shift as move, viewRange, type View3 } from '@/ranges';
import { useSession } from '@/session';
import { supabase } from '@/supabase';
import { Badge, Button, Card, Muted, Row, Screen } from '@/ui';

const dayFmt = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
const time = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });

// Calendario de guardias (día / semana / mes) con cobertura y mi inscripción.
export default function Shifts() {
  const { membership } = useSession();
  const router = useRouter();
  const [view, setView] = useState<View3>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [items, setItems] = useState<any[]>([]);
  const [mine, setMine] = useState<Map<string, string>>(new Map());
  const { start, end } = useMemo(() => viewRange(view, anchor), [view, anchor]);

  const load = useCallback(async () => {
    if (!membership) return;
    const { data } = await supabase.from('shift_coverage').select('*').eq('org_id', membership.orgId)
      .lt('starts_at', end.toISOString()).gt('ends_at', start.toISOString()).order('starts_at');
    setItems(data ?? []);
    const { data: su } = await supabase.from('shift_signups').select('shift_id, status').eq('member_id', membership.id).neq('status', 'cancelled');
    setMine(new Map((su ?? []).map((x: any) => [x.shift_id, x.status])));
  }, [membership, start, end]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => {
    if (!membership) return;
    const ch = supabase.channel(`shifts-m-${membership.orgId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shift_signups', filter: `org_id=eq.${membership.orgId}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts', filter: `org_id=eq.${membership.orgId}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [membership, load]);

  const byDay = new Map<string, any[]>();
  for (const it of items) {
    const k = dayFmt.format(new Date(it.starts_at));
    byDay.set(k, [...(byDay.get(k) ?? []), it]);
  }

  return (
    <Screen>
      <Row>
        {(['day', 'week', 'month'] as View3[]).map((v) => (
          <Button key={v} variant={view === v ? 'primary' : 'neutral'} label={{ day: 'Día', week: 'Semana', month: 'Mes' }[v]} onPress={() => setView(v)} />
        ))}
      </Row>
      <Row>
        <Button variant="neutral" label="←" onPress={() => setAnchor(move(view, anchor, -1))} hint="Anterior" />
        <Button variant="neutral" label="Hoy" onPress={() => setAnchor(new Date())} />
        <Button variant="neutral" label="→" onPress={() => setAnchor(move(view, anchor, 1))} hint="Siguiente" />
      </Row>
      {!items.length && <Muted>No hay guardias en este periodo.</Muted>}
      {[...byDay.entries()].map(([day, list]) => (
        <Card key={day}>
          <Text style={{ fontSize: 17, fontWeight: '800', textTransform: 'capitalize' }}>{day}</Text>
          {list.map((s) => {
            const my = mine.get(s.id);
            return (
              <Pressable key={s.id} onPress={() => router.push({ pathname: '/guardia/[id]', params: { id: s.id } })}
                style={{ paddingVertical: 12, gap: 6 }} accessibilityRole="button">
                <Text style={{ fontSize: 17, fontWeight: '700' }}>{time.format(new Date(s.starts_at))}–{time.format(new Date(s.ends_at))} · {s.title}</Text>
                <Row>
                  {s.status === 'cancelled' ? <Badge tone="neutral" icon="⛔" text="Cancelada" />
                    : s.coverage === 'below_minimum' ? <Badge tone="warning" icon="⚠" text={`Faltan personas: ${s.signed_up_count}/${s.min_volunteers}`} />
                    : <Badge tone="success" icon="✅" text={`${s.signed_up_count}${s.max_volunteers ? `/${s.max_volunteers}` : ''} personas`} />}
                  {s.status === 'full' && <Badge tone="neutral" text="Completa" />}
                  {my && <Badge tone="info" icon="👤" text={my === 'confirmed' ? 'Confirmada' : 'Apuntado'} />}
                </Row>
              </Pressable>
            );
          })}
        </Card>
      ))}
    </Screen>
  );
}
