import { errorMessage, type AgendaKind } from '@guardia/core';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Text } from 'react-native';

import { KIND_LABEL } from '@/agenda';
import { useSession } from '@/session';
import { supabase } from '@/supabase';
import { Badge, Button, Card, Muted, Notice, Screen, Title } from '@/ui';

const fmt = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

export default function EventDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { membership } = useSession();
  const [ev, setEv] = useState<any>(null);
  const [people, setPeople] = useState<{ name: string; me: boolean }[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!membership) return;
    const { data } = await supabase.from('events').select('*').eq('id', id).single();
    setEv(data);
    const [{ data: su }, { data: dir }] = await Promise.all([
      supabase.from('event_signups').select('member_id').eq('event_id', id).neq('status', 'cancelled'),
      supabase.rpc('member_directory', { p_org: membership.orgId }),
    ]);
    const names = new Map((dir ?? []).map((d: any) => [d.member_id, d.display_name]));
    setPeople((su ?? []).map((x: any) => ({ name: names.get(x.member_id) ?? '—', me: x.member_id === membership.id })));
  }, [id, membership]);
  useEffect(() => { load(); }, [load]);

  async function act(join: boolean) {
    setBusy(true);
    const { error } = await supabase.rpc(join ? 'sign_up_for_event' : 'cancel_event_signup', { p_event: id });
    setBusy(false);
    setMsg(error ? { ok: false, text: errorMessage('es', error) } : { ok: true, text: join ? '✅ Inscripción confirmada.' : 'Inscripción cancelada.' });
    load();
  }

  if (!ev) return <Screen><Muted>Cargando…</Muted></Screen>;
  const me = people.some((p) => p.me);
  const full = ev.capacity != null && people.length >= ev.capacity;
  const open = ev.status === 'scheduled' && new Date(ev.ends_at) > new Date();
  return (
    <Screen>
      <Badge tone="info" text={KIND_LABEL[ev.type as AgendaKind]} />
      <Title>{ev.title}</Title>
      <Text style={{ fontSize: 17 }}>{fmt.format(new Date(ev.starts_at))}</Text>
      {ev.location_text && <Muted>📍 {ev.location_text}</Muted>}
      {ev.description && <Text style={{ fontSize: 16 }}>{ev.description}</Text>}
      {ev.status === 'cancelled' && <Notice tone="danger">Cancelado{ev.cancel_reason ? `: ${ev.cancel_reason}` : ''}</Notice>}
      {msg && <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice>}
      <Muted>{ev.capacity ? `Plazas: ${people.length} de ${ev.capacity}` : `${people.length} inscritos`}</Muted>
      {open && (me
        ? <Button variant="neutral" label="Cancelar mi inscripción" onPress={() => act(false)} busy={busy} />
        : <Button big variant="primary" label={full ? 'SIN PLAZAS' : 'INSCRIBIRME'} disabled={full} onPress={() => act(true)} busy={busy} />)}
      <Card>
        <Text style={{ fontSize: 17, fontWeight: '800' }}>Participantes</Text>
        {people.map((p, i) => <Text key={i} style={{ fontSize: 16, paddingVertical: 4 }}>{p.name}{p.me ? ' (tú)' : ''}</Text>)}
      </Card>
    </Screen>
  );
}
