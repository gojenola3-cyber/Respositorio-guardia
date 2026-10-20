import { errorMessage, roleLabel } from '@guardia/core';
import * as Location from 'expo-location';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking, Switch, Text, TextInput, View } from 'react-native';

import { notificationPermissionSummary, registerForPush, unregisterPush } from '@/notifications';
import { useSession } from '@/session';
import { supabase } from '@/supabase';
import { Badge, Button, Card, Muted, Notice, Row, s, Screen, Title } from '@/ui';

// Perfil, especialidades, preferencias de notificación y privacidad.
export default function Profile() {
  const { session, membership } = useSession();
  const [profile, setProfile] = useState<any>(null);
  const [quals, setQuals] = useState<any[]>([]);
  const [perm, setPerm] = useState<{ granted: boolean; critical: boolean } | null>(null);
  const [loc, setLoc] = useState<string>('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!session || !membership) return;
    const { data } = await supabase.from('profiles').select('*').eq('id', session.user.id).single();
    setProfile(data);
    const { data: mq } = await supabase.from('member_qualifications').select('expires_on, qualifications(code, name)').eq('member_id', membership.id);
    setQuals(mq ?? []);
    setPerm(await notificationPermissionSummary());
    setLoc((await Location.getForegroundPermissionsAsync()).status);
  }, [session, membership]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function save(patch: Record<string, unknown>, ok = 'Guardado.') {
    const { error } = await supabase.from('profiles').update(patch).eq('id', session!.user.id);
    setMsg(error ? { ok: false, text: errorMessage('es', error) } : { ok: true, text: ok });
    load();
  }

  async function testPush() {
    const reg = await registerForPush();
    if (!reg.ok) {
      const text = { not_device: 'Las notificaciones solo funcionan en un móvil real.', denied: 'Permiso de notificaciones denegado: actívalo en Ajustes.', no_project: 'App sin configurar (falta el proyecto EAS).', error: `Error: ${reg.detail ?? ''}` }[reg.reason];
      return setMsg({ ok: false, text });
    }
    const { data, error } = await supabase.functions.invoke('dispatch', { body: { action: 'test' } });
    setMsg(error || data?.error ? { ok: false, text: 'No se pudo enviar la prueba. Revisa la conexión.' } : { ok: true, text: 'Prueba enviada: debería sonar en unos segundos.' });
  }

  if (!profile || !membership) return <Screen><Muted>Cargando…</Muted></Screen>;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Screen>
      <Title>{profile.first_name} {profile.last_name}</Title>
      <Muted>{profile.email} · {roleLabel('es', membership.role)} · {membership.orgName}</Muted>
      {msg && <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice>}

      <Card>
        <Text style={{ fontSize: 18, fontWeight: '800' }}>Mis datos</Text>
        <View><Text style={s.label}>Teléfono (para contacto en emergencias)</Text>
          <TextInput style={s.input} defaultValue={profile.phone ?? ''} keyboardType="phone-pad" autoComplete="tel"
            onEndEditing={(e) => save({ phone: e.nativeEvent.text.trim() || null }, 'Teléfono guardado.')} /></View>
        <Muted>Solo lo ven los responsables. El resto de voluntarios solo ve tu nombre e inicial.</Muted>
      </Card>

      <Card>
        <Text style={{ fontSize: 18, fontWeight: '800' }}>Especialidades</Text>
        {quals.length ? quals.map((q: any, i) => (
          <Row key={i}><Text style={{ fontSize: 16 }}>{q.qualifications?.code} · {q.qualifications?.name}</Text>
            {q.expires_on && <Badge tone={q.expires_on < today ? 'warning' : 'neutral'} icon={q.expires_on < today ? '⚠' : undefined} text={q.expires_on < today ? `Caducada ${q.expires_on}` : `Hasta ${q.expires_on}`} />}</Row>
        )) : <Muted>Sin especialidades registradas. Las gestiona un administrador.</Muted>}
      </Card>

      <Card>
        <Text style={{ fontSize: 18, fontWeight: '800' }}>Notificaciones</Text>
        <Row>{perm?.granted ? <Badge tone="success" icon="✅" text="Permitidas" /> : <Badge tone="danger" icon="⛔" text="Desactivadas" />}
          {perm?.critical && <Badge tone="info" text="Alertas críticas" />}</Row>
        {!perm?.granted && <Notice tone="danger">Sin permiso de notificaciones no recibirás las alertas de emergencia.</Notice>}
        <Muted>Las alertas de emergencia no se pueden desactivar mientras estés de guardia o disponible. Para que suenen en "No molestar", añade Guardia como excepción en los ajustes del móvil.</Muted>
        <Row><Button variant="primary" label="Probar aviso" onPress={testPush} /><Button variant="neutral" label="Ajustes del móvil" onPress={() => Linking.openSettings()} /></Row>
        {[
          ['notify_shift_reminders', 'Recordatorios de mis guardias'],
          ['notify_agenda_changes', 'Cambios y cancelaciones de la agenda'],
          ['notify_email', 'Copia por correo electrónico'],
        ].map(([key, label]) => (
          <Row key={key} style={{ justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 16, flex: 1 }}>{label}</Text>
            <Switch value={!!profile[key!]} onValueChange={(v) => save({ [key!]: v })} accessibilityLabel={label} />
          </Row>
        ))}
      </Card>

      <Card>
        <Text style={{ fontSize: 18, fontWeight: '800' }}>Privacidad y ubicación</Text>
        <Muted>Tu ubicación solo se comparte si aceptas acudir a una emergencia y lo autorizas en ese momento. Se guarda solo la última posición y se borra al llegar o al cerrar.</Muted>
        <Badge tone={loc === 'granted' ? 'success' : 'neutral'} text={loc === 'granted' ? 'Permiso de ubicación: concedido (mientras se usa)' : 'Permiso de ubicación: no concedido'} />
        <Button variant="neutral" label="Gestionar permisos en Ajustes" onPress={() => Linking.openSettings()} />
      </Card>

      <Button variant="ghost" label="Cerrar sesión" onPress={async () => { await unregisterPush(); await supabase.auth.signOut(); }} />
    </Screen>
  );
}
