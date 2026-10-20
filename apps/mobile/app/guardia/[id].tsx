import { errorMessage } from '@guardia/core';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Text } from 'react-native';

import { useSession } from '@/session';
import { supabase } from '@/supabase';
import { Badge, Button, Card, Muted, Notice, Screen, Title } from '@/ui';

const fmt = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

// Detalle de guardia: quién está apuntado, cobertura e inscripción.
export default function ShiftDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { membership } = useSession();
  const [shift, setShift] = useState<any>(null);
  const [roster, setRoster] = useState<{ name: string; confirmed: boolean; me: boolean }[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!membership) return;
    const { data: s } = await supabase.from('shift_coverage').select('*').eq('id', id).single();
    setShift(s);
    const [{ data: su }, { data: dir }] = await Promise.all([
      supabase.from('shift_signups').select('member_id, status').eq('shift_id', id).neq('status', 'cancelled'),
      supabase.rpc('member_directory', { p_org: membership.orgId }),
    ]);
    const names = new Map((dir ?? []).map((d: any) => [d.member_id, d.display_name]));
    setRoster((su ?? []).map((x: any) => ({ name: names.get(x.member_id) ?? '—', confirmed: x.status === 'confirmed', me: x.member_id === membership.id })));
  }, [id, membership]);
  useEffect(() => { load(); }, [load]);

  async function act(signUp: boolean) {
    setBusy(true);
    const { error } = await supabase.rpc(signUp ? 'sign_up_for_shift' : 'cancel_shift_signup', { p_shift: id });
    setBusy(false);
    setMsg(error ? { ok: false, text: errorMessage('es', error) } : { ok: true, text: signUp ? '✅ Te has apuntado a la guardia.' : 'Te has desapuntado.' });
    load();
  }

  if (!shift) return <Screen><Muted>Cargando…</Muted></Screen>;
  const me = roster.find((r) => r.me);
  return (
    <Screen>
      <Title>{shift.title}</Title>
      <Text style={{ fontSize: 17 }}>{fmt.format(new Date(shift.starts_at))}</Text>
      <Muted>Hasta {fmt.format(new Date(shift.ends_at))}</Muted>
      {msg && <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice>}
      {shift.coverage === 'below_minimum'
        ? <Badge tone="warning" icon="⚠" text={`Bajo mínimo: ${shift.signed_up_count} de ${shift.min_volunteers}`} />
        : <Badge tone="success" icon="✅" text={`Cubierta: ${shift.signed_up_count} personas`} />}
      {me ? (
        <>
          <Notice tone="success">{me.confirmed ? 'Tu guardia está confirmada por el responsable.' : 'Estás apuntado. El responsable puede confirmarla.'}</Notice>
          <Button variant="neutral" label="Desapuntarme" onPress={() => act(false)} busy={busy} />
        </>
      ) : shift.status === 'open' && new Date(shift.ends_at) > new Date() ? (
        <Button big variant="primary" label="APUNTARME" onPress={() => act(true)} busy={busy} />
      ) : <Muted>No admite inscripciones ({{ full: 'completa', closed: 'cerrada', cancelled: 'cancelada', open: 'terminada' }[shift.status as string]}).</Muted>}
      <Muted>Apuntarte indica disponibilidad para la guardia. Los servicios que requieran formación se asignan según tus acreditaciones.</Muted>
      <Card>
        <Text style={{ fontSize: 17, fontWeight: '800' }}>Apuntados ({roster.length})</Text>
        {roster.map((r, i) => <Text key={i} style={{ fontSize: 16, paddingVertical: 4 }}>{r.name}{r.me ? ' (tú)' : ''}{r.confirmed ? ' · ✅ confirmada' : ''}</Text>)}
      </Card>
    </Screen>
  );
}
