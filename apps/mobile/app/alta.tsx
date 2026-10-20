import { errorMessage } from '@guardia/core';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { useSession } from '@/session';
import { supabase } from '@/supabase';
import { Button, Card, Muted, Notice, s, Screen, Title } from '@/ui';

export default function Join() {
  const { refresh, pendingRequest } = useSession();
  const [token, setToken] = useState('');
  const [slug, setSlug] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function accept() {
    // Admite el enlace completo o solo el código.
    const code = token.includes('token=') ? token.split('token=')[1]!.split('&')[0]! : token.trim();
    const { error } = await supabase.rpc('accept_invitation', { p_token: code });
    if (error) return setMsg({ ok: false, text: errorMessage('es', error) });
    await refresh();
  }

  async function request() {
    const { error } = await supabase.rpc('request_membership', { p_slug: slug.trim().toLowerCase() });
    setMsg(error ? { ok: false, text: errorMessage('es', error) } : { ok: true, text: 'Solicitud enviada. Un administrador tiene que aprobarla.' });
    refresh();
  }

  return (
    <Screen>
      <Title>Unirse a tu organización</Title>
      {pendingRequest && <Notice>Tienes una solicitud pendiente de aprobación.</Notice>}
      {msg && <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice>}
      <Card>
        <Text style={s.label}>Tengo una invitación</Text>
        <TextInput style={s.input} value={token} onChangeText={setToken} placeholder="Pega aquí el enlace o el código" autoCapitalize="none" autoCorrect={false} />
        <Button label="Aceptar invitación" onPress={accept} disabled={!token} />
      </Card>
      <Card>
        <Text style={s.label}>Solicitar acceso</Text>
        <TextInput style={s.input} value={slug} onChangeText={setSlug} placeholder="Identificador de la organización" autoCapitalize="none" autoCorrect={false} />
        <Button variant="neutral" label="Enviar solicitud" onPress={request} disabled={!slug} />
      </Card>
      <View><Button variant="ghost" label="Cerrar sesión" onPress={() => supabase.auth.signOut()} /></View>
      <Muted>La invitación solo funciona con el correo al que se envió.</Muted>
    </Screen>
  );
}
