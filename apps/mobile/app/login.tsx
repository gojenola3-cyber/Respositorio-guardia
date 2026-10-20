import { t } from '@guardia/core';
import { Link } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { supabase } from '@/supabase';
import { Button, Card, Muted, Notice, s, Screen, Title } from '@/ui';

export default function Login() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    setBusy(true);
    setMsg(null);
    const mail = email.trim().toLowerCase();
    if (mode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email: mail, password });
      if (error) setMsg({ ok: false, text: 'Correo o contraseña incorrectos, o cuenta sin confirmar.' });
    } else {
      const { error } = await supabase.auth.signUp({
        email: mail, password, options: { data: { first_name: first.trim(), last_name: last.trim() } },
      });
      setMsg(error ? { ok: false, text: error.message } : { ok: true, text: 'Revisa tu correo para confirmar la cuenta y vuelve a entrar.' });
    }
    setBusy(false);
  }

  return (
    <Screen>
      <Title>Guardia</Title>
      <Muted>{t('es', 'app.disclaimer')}</Muted>
      <Card>
        {mode === 'signup' && (
          <>
            <View><Text style={s.label}>Nombre</Text><TextInput style={s.input} value={first} onChangeText={setFirst} autoComplete="given-name" /></View>
            <View><Text style={s.label}>Apellidos</Text><TextInput style={s.input} value={last} onChangeText={setLast} autoComplete="family-name" /></View>
          </>
        )}
        <View><Text style={s.label}>Correo electrónico</Text>
          <TextInput style={s.input} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" textContentType="emailAddress" /></View>
        <View><Text style={s.label}>Contraseña</Text>
          <TextInput style={s.input} value={password} onChangeText={setPassword} secureTextEntry autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></View>
        {msg && <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice>}
        <Button label={mode === 'login' ? 'Entrar' : 'Crear cuenta'} onPress={submit} busy={busy}
          disabled={!email || password.length < (mode === 'signup' ? 10 : 1) || (mode === 'signup' && (!first || !last))} />
      </Card>
      <Button variant="ghost" label={mode === 'login' ? 'Crear una cuenta' : 'Ya tengo cuenta'} onPress={() => setMode(mode === 'login' ? 'signup' : 'login')} />
      <Link href="/recuperar" style={{ textAlign: 'center', fontSize: 16, padding: 12 }}>He olvidado la contraseña</Link>
      {mode === 'signup' && <Muted>Crear una cuenta no da acceso a ninguna organización: necesitas una invitación o la aprobación de un administrador. Contraseña de 10 caracteres o más.</Muted>}
    </Screen>
  );
}
