'use client';
import { errorMessage, t } from '@guardia/core';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { supabaseBrowser } from '@/lib/supabase/client';

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get('next') ?? '/';
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email')).trim().toLowerCase();
    const password = String(form.get('password'));
    setBusy(true);
    setError(null);
    const supabase = supabaseBrowser();
    if (mode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setBusy(false);
      if (error) return setError('Correo o contraseña incorrectos, o cuenta sin confirmar.');
      router.replace(next.startsWith('/') ? next : '/');
      router.refresh();
    } else {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${location.origin}/auth/callback?next=/alta`,
          data: { first_name: String(form.get('first_name') ?? ''), last_name: String(form.get('last_name') ?? '') },
        },
      });
      setBusy(false);
      if (error) return setError(errorMessage('es', error));
      setInfo('Te hemos enviado un correo para confirmar la cuenta.');
    }
  }

  return (
    <main className="main" style={{ maxWidth: 460, margin: '8vh auto' }}>
      <h1>Guardia</h1>
      <p className="muted">{t('es', 'app.disclaimer')}</p>
      <form className="card" onSubmit={submit}>
        {mode === 'signup' && (
          <>
            <label>Nombre<input name="first_name" required autoComplete="given-name" /></label>
            <label>Apellidos<input name="last_name" required autoComplete="family-name" /></label>
          </>
        )}
        <label>Correo electrónico<input name="email" type="email" required autoComplete="email" /></label>
        <label>
          Contraseña
          <input name="password" type="password" required minLength={10}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          {mode === 'signup' && <span className="hint">Mínimo 10 caracteres.</span>}
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        {info && <p className="notice" role="status">{info}</p>}
        <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
          {mode === 'login' ? 'Entrar' : 'Crear cuenta'}
        </button>
      </form>
      <div className="row between">
        <button className="btn btn-ghost" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
          {mode === 'login' ? 'Crear una cuenta' : 'Ya tengo cuenta'}
        </button>
        <Link href="/recuperar">He olvidado la contraseña</Link>
      </div>
      {mode === 'signup' && (
        <p className="muted">Crear una cuenta no da acceso a ninguna organización: necesitas una invitación o la aprobación de un administrador.</p>
      )}
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
