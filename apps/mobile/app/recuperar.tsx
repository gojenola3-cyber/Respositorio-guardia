import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { supabase } from '@/supabase';
import { Button, Card, Muted, Notice, s, Screen, Title } from '@/ui';

// Envía el enlace de recuperación. El cambio de contraseña se completa en la
// web del panel (/recuperar), que abre el enlace del correo.
export default function Recover() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
    if (error?.status === 429) return setError('Demasiados intentos. Espera unos minutos.');
    setSent(true); // mismo mensaje exista o no la cuenta
  }

  return (
    <Screen>
      <Title>Recuperar acceso</Title>
      {sent ? <Notice tone="success">Si el correo está registrado, recibirás un enlace para elegir una contraseña nueva.</Notice> : (
        <Card>
          <View><Text style={s.label}>Correo electrónico</Text>
            <TextInput style={s.input} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" /></View>
          {error && <Notice tone="danger">{error}</Notice>}
          <Button label="Enviar enlace" onPress={send} disabled={!email} />
        </Card>
      )}
      <Muted>Si no recibes el correo, pide a un administrador que revise tu cuenta.</Muted>
    </Screen>
  );
}
