'use client';
import { useState } from 'react';

import { supabaseBrowser } from '@/lib/supabase/client';

/** Recuperación de acceso: envía un enlace y, al volver, permite fijar una contraseña nueva. */
export default function RecoverPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovering] = useState(() => typeof location !== 'undefined' && location.hash.includes('type=recovery'));
  const [done, setDone] = useState(false);

  async function request(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get('email')).trim();
    const { error } = await supabaseBrowser().auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}/auth/callback?next=/recuperar%23type=recovery`,
    });
    if (error?.status === 429) return setError('Demasiados intentos. Espera unos minutos.');
    // Mismo mensaje exista o no la cuenta: no se revela quién está registrado.
    setSent(true);
  }

  async function update(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get('password'));
    const { error } = await supabaseBrowser().auth.updateUser({ password });
    if (error) return setError('No se ha podido cambiar la contraseña. Pide un enlace nuevo.');
    setDone(true);
  }

  return (
    <main className="main" style={{ maxWidth: 460, margin: '8vh auto' }}>
      <h1>Recuperar acceso</h1>
      {recovering ? (
        done ? <p className="notice">Contraseña actualizada. <a href="/">Entrar</a></p> : (
          <form className="card" onSubmit={update}>
            <label>Nueva contraseña<input name="password" type="password" minLength={10} required autoComplete="new-password" /></label>
            {error && <p className="error">{error}</p>}
            <button className="btn btn-primary">Guardar</button>
          </form>
        )
      ) : sent ? (
        <p className="notice">Si el correo está registrado, recibirás un enlace para elegir una contraseña nueva.</p>
      ) : (
        <form className="card" onSubmit={request}>
          <label>Correo electrónico<input name="email" type="email" required autoComplete="email" /></label>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary">Enviar enlace</button>
        </form>
      )}
    </main>
  );
}
